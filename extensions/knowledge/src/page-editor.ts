import type { FeatureClient, FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import { Check } from "typebox/value";
import { ATTACHMENT_CHUNK_BYTES } from "./attachment-contract.js";
import { contract } from "./contract.js";
import { DraftStore, type EditorDraft } from "./drafts.js";
import { loadVocabulary } from "./inspection-client.js";
import { BODY_INPUT_MAX_CHARS } from "./limits.js";
import type { Evidence } from "./model.js";
import {
  SavePage,
  ClaimInput,
  RelationshipInput,
  type WriteInput,
  type WriteKind,
} from "./mutation-contract.js";

type RecordDetail = NonNullable<FeatureOutput<typeof contract, "record">["record"]>;
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const node = document.createElement(tag);
  if (text) {
    node.textContent = text;
  }
  return node;
};
/** The dialog lives outside refreshed content; errors/reconnects don't erase a draft. */
export async function pageEditor(
  parent: HTMLElement,
  feature: FeatureClient<typeof contract>,
  record: RecordDetail | undefined,
  saved: (id: string) => void,
  redact: (message: string) => string,
  recovery?: {
    store: DraftStore;
    draft?: EditorDraft;
    signal: AbortSignal;
    dismissed?: () => void;
  },
  initialKind: WriteKind = "page",
) {
  const restored = recovery?.draft,
    kind = restored?.kind ?? initialKind;
  let fingerprint = "";
  const base =
    restored?.base ??
    (record ? { id: record.id, revision: record.revision, hash: record.hash } : undefined);
  const draftKey = restored?.key ?? crypto.randomUUID();
  const dialog = element("dialog");
  dialog.className = "knowledge-editor";
  const recoveryNotice = element("p");
  recoveryNotice.setAttribute("role", "alert");
  const form = element("form"),
    feedback = element("p");
  feedback.setAttribute("role", "status");
  const title = element("input");
  title.value = restored?.title ?? record?.title ?? "";
  title.required = true;
  title.maxLength = 200;
  const type = element("select");
  type.required = kind !== "claim";
  const body = element("textarea");
  body.value = restored?.body ?? record?.body ?? "";
  body.rows = 16;
  body.maxLength = BODY_INPUT_MAX_CHARS;
  const fields = element("textarea");
  fields.rows = 4;
  fields.value =
    restored?.fields ?? (record ? JSON.stringify(record.metadata?.fields ?? {}, null, 2) : "{}");
  const source = element("textarea");
  source.rows = 4;
  source.value = restored?.source ?? "";
  const files = element("input");
  files.type = "file";
  files.multiple = true;
  const attached = element("ul"),
    attachments: Evidence[] = [...(restored?.attachments ?? [])];
  const renderAttachments = () => {
    attached.replaceChildren(...attachments.map((e) => element("li", e.filename ?? e.path)));
  };
  renderAttachments();
  const pendingUploads = new Map<
    File,
    { requestId: string; offset: number; attribution: string }
  >();
  const attribution = element("input");
  attribution.maxLength = 1000;
  attribution.value = restored?.attribution ?? "";
  const field = (name: string, control: HTMLElement) => {
    const label = element("label", name);
    control.setAttribute("aria-label", name);
    label.append(control);
    return label;
  };
  const values: Record<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement> = {};
  const extra = element("div");
  const add = (key: string, label: string, options?: string[], multiline = false) => {
    const control = options
      ? element("select")
      : multiline
        ? element("textarea")
        : element("input");
    if (control instanceof HTMLSelectElement) {
      for (const value of options!) {
        const option = element("option", value.replaceAll("_", " "));
        option.value = value;
        control.append(option);
      }
    }
    // SAFETY: metadata is the record's frontmatter object; absent keys read undefined, narrowed below.
    const current = (record?.metadata as Record<string, unknown> | undefined)?.[key];
    control.value =
      restored?.values?.[key] ??
      (Array.isArray(current)
        ? current.join("\n")
        : typeof current === "string"
          ? current
          : (options?.[0] ?? ""));
    values[key] = control;
    extra.append(field(label, control));
    return control;
  };
  if (kind === "page") {
    add("aliases", "Aliases (one per line)", undefined, true);
    add("tags", "Tags (one per line)", undefined, true);
  }
  add("dependencies", "Depends on record IDs (one per line)", undefined, true);
  if (kind === "claim") {
    add("claim_kind", "Claim kind", [
      "fact",
      "preference",
      "decision",
      "commitment",
      "event",
      "belief",
    ]);
    add("assertion_origin", "Assertion origin", ["source", "user_belief", "agent_inference"]);
    add("entities", "About page IDs (one per line)", undefined, true);
    add("occurred_at", "Occurred on (date or timestamp with timezone)");
    add("owner", "Commitment owner", [""]);
    add("due_at", "Commitment due (date or timestamp with timezone)");
  }
  if (kind === "relationship") {
    add("from", "From page", [""]);
    add("to", "To page", [""]);
  }
  if (kind !== "page") {
    add("valid_from", "Valid from (UTC timestamp)");
    add("valid_until", "Valid until (UTC timestamp)");
    add("expires_at", "Expires at (UTC timestamp)");
    add("evidence", "Existing evidence / exact locators (JSON array)", undefined, true).value =
      restored?.values?.evidence ?? "[]";
    attribution.required = true;
  }
  const controls = [
    title,
    type,
    body,
    fields,
    source,
    attribution,
    files,
    ...Object.values(values),
  ];
  const close = element("button", "Close draft");
  close.type = "button";
  close.addEventListener("click", () => dialog.close());
  const save = element("button", `Save ${kind}`);
  save.type = "submit";
  save.disabled = true;
  form.append(
    element("h2", base ? "Edit page" : `New ${kind}`),
    field("Title", title),
    ...(kind === "claim"
      ? []
      : [field(kind === "page" ? "Page type" : "Relationship label", type)]),
    field("Markdown", body),
    extra,
  );
  const advanced = element("details");
  advanced.open = kind !== "page";
  advanced.append(
    element("summary", "Structured fields & source evidence"),
    field("Fields (JSON object)", fields),
    field("Attach source files (optional)", files),
    field(
      kind === "page"
        ? "Source attribution (optional; defaults to filename)"
        : "Assertion attribution (required)",
      attribution,
    ),
    attached,
    ...(source.value ? [field("Recovered source text", source)] : []),
  );
  form.append(advanced, recoveryNotice, feedback, save, close);
  dialog.append(form);
  parent.append(dialog);
  // Closing keeps the draft available for this mount. Explicit discard removes it.
  const reopen = element("button", "Reopen draft");
  reopen.type = "button";
  reopen.hidden = true;
  reopen.addEventListener("click", () => {
    reopen.hidden = true;
    dialog.showModal();
  });
  parent.append(reopen);
  const discard = element("button", "Discard draft");
  discard.type = "button";
  discard.addEventListener("click", () => {
    if (saving || submitted) {
      feedback.textContent = "Resolve the existing save before discarding this draft.";
      return;
    }
    if (!window.confirm("Discard this unsaved draft?")) {
      return;
    }
    recovery?.store.remove(draftKey);
    dialog.removeEventListener("close", showReopen);
    dialog.close();
    dialog.remove();
    reopen.remove();
    recovery?.dismissed?.();
  });
  form.append(discard);
  const showReopen = () => {
    reopen.hidden = false;
  };
  dialog.addEventListener("close", showReopen);
  dialog.showModal();
  let submitted: WriteInput | undefined = restored?.submitted,
    saving = false;
  const persist = () => {
    if (!recovery) {
      return true;
    }
    try {
      recovery.store.write({
        version: 1,
        key: draftKey,
        kind,
        values: Object.fromEntries(
          Object.entries(values).map(([key, value]) => [key, value.value]),
        ),
        title: title.value,
        body: body.value,
        type: type.value || restored?.type || record?.type || "",
        fields: fields.value,
        source: source.value,
        attribution: attribution.value,
        attachments,
        ...(base ? { base } : {}),
        ...(submitted ? { submitted } : {}),
      });
      return true;
    } catch {
      recoveryNotice.textContent =
        "Browser draft recovery unavailable. Keep this page open and copy your text before leaving.";
      return false;
    }
  };
  form.addEventListener("input", () => persist());
  form.addEventListener("change", () => persist());
  persist();
  if (restored) {
    feedback.textContent = submitted
      ? "Recovered draft with an unresolved save. Retry uses the original request."
      : "Recovered unsaved draft from this tab. Nothing has been published.";
  }
  const reloadOptions = element("button", "Reload authoring options");
  reloadOptions.type = "button";
  reloadOptions.hidden = true;
  form.append(reloadOptions);
  const loadOptions = async () => {
    try {
      const selectedType = type.value || restored?.type || record?.type;
      const selectedPages = Object.fromEntries(
        ["from", "to", "owner"].map((key) => [
          key,
          values[key]?.value || restored?.values?.[key] || "",
        ]),
      );
      const ontology = await loadVocabulary(feature, kind === "relationship");
      fingerprint = ontology.fingerprint;
      type.replaceChildren();
      for (const definition of ontology.definitions.filter((d) => d.kind === kind)) {
        const option = element("option", definition.label);
        option.value = definition.name;
        type.append(option);
      }
      type.value =
        selectedType ||
        (kind === "page" && ontology.definitions.some((d) => d.name === "note")
          ? "note"
          : type.value);
      type.disabled = Boolean(base);
      if (kind !== "page") {
        for (const key of ["from", "to", "owner"]) {
          if (values[key]) {
            const empty = element("option", "Unknown / not selected");
            empty.value = "";
            values[key].replaceChildren(empty);
          }
        }
        let offset: number | null = 0;
        while (offset !== null) {
          const page: FeatureOutput<typeof contract, "records"> = await feature.invoke("records", {
            kind: "page",
            offset,
            limit: 100,
          });
          for (const pageRecord of page.records.filter(
            (r) => r.valid && r.lifecycle === "active",
          )) {
            for (const key of ["from", "to", "owner"]) {
              const select = values[key];
              if (!(select instanceof HTMLSelectElement)) {
                continue;
              }
              const option = element("option", `${pageRecord.title} · ${pageRecord.type}`);
              option.value = pageRecord.id;
              select.append(option);
            }
          }
          offset = page.nextOffset;
        }
        for (const key of ["from", "to", "owner"]) {
          if (values[key]) {
            values[key].value = selectedPages[key]!;
          }
        }
      }
      if (submitted) {
        for (const control of controls) {
          control.disabled = true;
        }
      }
      save.textContent = submitted ? "Retry same save" : `Save ${kind}`;
      save.disabled = !ontology.available;
      persist();
      reloadOptions.hidden = true;
    } catch (e) {
      feedback.textContent = redact(String(e));
      reloadOptions.hidden = false;
    }
  };
  reloadOptions.addEventListener("click", () => {
    void loadOptions();
  });
  await loadOptions();
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (saving) {
      return;
    }
    saving = true;
    save.disabled = true;
    for (const control of controls) {
      control.disabled = true;
    }
    try {
      if (!submitted) {
        const parsed: unknown = JSON.parse(fields.value);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
          throw new Error("Fields must be a JSON object.");
        }
        if (source.value && !attribution.value.trim()) {
          throw new Error("Add attribution for the retained source text.");
        }
        for (const file of Array.from(files.files ?? [])) {
          let upload = pendingUploads.get(file);
          if (!upload) {
            upload = {
              requestId: crypto.randomUUID(),
              offset: 0,
              attribution: attribution.value.trim() || file.name,
            };
            pendingUploads.set(file, upload);
          }
          if (attachments.some((e) => e.path.startsWith(`artifacts/${upload!.requestId}/`))) {
            continue;
          }
          while (true) {
            feedback.textContent = `Attaching ${file.name}: ${upload.offset.toLocaleString()} / ${file.size.toLocaleString()} bytes…`;
            const bytes = new Uint8Array(
              await file.slice(upload.offset, upload.offset + ATTACHMENT_CHUNK_BYTES).arrayBuffer(),
            );
            let binary = "";
            for (let i = 0; i < bytes.length; i += 8192) {
              binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
            }
            const receipt = await feature.invoke("attach", {
              requestId: upload.requestId,
              ...(recovery ? { expectedVaultId: recovery.store.vaultId } : {}),
              filename: file.name,
              mediaType: file.type || "application/octet-stream",
              attribution: upload.attribution,
              offset: upload.offset,
              data: btoa(binary),
              final: upload.offset + bytes.length === file.size,
            });
            upload.offset = receipt.receivedBytes;
            if (receipt.state === "complete" && receipt.evidence) {
              attachments.push(receipt.evidence);
              renderAttachments();
              persist();
              break;
            }
          }
        }
        const lines = (key: string) =>
          values[key]?.value
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean) ?? [];
        const common = {
          requestId: crypto.randomUUID(),
          ...(recovery ? { expectedVaultId: recovery.store.vaultId } : {}),
          expectedOntologyFingerprint: fingerprint,
          title: title.value,
          body: body.value,
          dependencies: lines("dependencies"),
        };
        if (kind === "page") {
          submitted = {
            ...common,
            type: type.value,
            // SAFETY: parsed is a non-null, non-array JSON object (checked above).
            fields: parsed as Record<string, unknown>,
            aliases: lines("aliases"),
            tags: lines("tags"),
            ...(base
              ? { id: base.id, expectedRevision: base.revision, expectedHash: base.hash }
              : {}),
            ...(attachments.length ? { attachments: [...attachments] } : {}),
            ...(source.value
              ? { source: { text: source.value, attribution: attribution.value } }
              : {}),
          };
        } else {
          const evidence = JSON.parse(values.evidence!.value);
          if (!Array.isArray(evidence)) {
            throw new Error("Evidence must be a JSON array.");
          }
          const temporal = Object.fromEntries(
            [
              "valid_from",
              "valid_until",
              "expires_at",
              ...(kind === "claim" ? ["occurred_at", "owner", "due_at"] : []),
            ]
              .filter((key) => values[key]?.value)
              .map((key) => [key, values[key]!.value]),
          );
          const assertion = {
            ...common,
            ...temporal,
            attribution: attribution.value,
            evidence: [...evidence, ...attachments],
          };
          const proposal =
            kind === "claim"
              ? {
                  ...assertion,
                  claim_kind: values.claim_kind!.value,
                  assertion_origin: values.assertion_origin!.value,
                  entities: lines("entities"),
                }
              : {
                  ...assertion,
                  from: values.from!.value,
                  to: values.to!.value,
                  label: type.value,
                  fields: parsed,
                };
          if (!Check(kind === "claim" ? ClaimInput : RelationshipInput, proposal)) {
            throw new Error("Check required attribution, evidence, record IDs and dates.");
          }
          submitted = proposal;
        }
      }
      persist();
      saving = true;
      save.disabled = true;
      feedback.textContent = "Saving…";
      for (const control of controls) {
        control.disabled = true;
      }
      // submitted was built for kind above, or restored from a draft persisted with this kind
      // whose payload drafts.ts checked against that kind's schema.
      const receipt =
        kind === "claim"
          ? await feature.invoke("create_claim", submitted as ClaimInput) // SAFETY: claim editor input.
          : kind === "relationship"
            ? await feature.invoke("create_relationship", submitted as RelationshipInput) // SAFETY: as above.
            : await feature.invoke("save_page", submitted as SavePage); // SAFETY: page editor input.
      if (receipt.state === "published") {
        recovery?.store.remove(draftKey);
        dialog.removeEventListener("close", showReopen);
        dialog.close();
        dialog.remove();
        reopen.remove();
        if (!recovery?.signal.aborted) {
          saved(receipt.id);
        }
        return;
      }
      feedback.textContent = receipt.message;
      save.textContent = "Retry publication";
    } catch (e) {
      feedback.textContent =
        redact(e instanceof Error ? e.message : String(e)) +
        (submitted
          ? " Your draft is retained. Retry uses the same request; copy the text before starting a revised draft."
          : "");
      if (submitted) {
        save.textContent = "Retry same save";
        try {
          const status = await feature.invoke("mutation", { requestId: submitted.requestId });
          if (!status.receipt) {
            submitted = undefined;
            for (const control of controls.filter((c) => c !== type)) {
              control.disabled = false;
            }
            type.disabled = Boolean(base);
            save.textContent = `Save ${kind}`;
            reloadOptions.hidden = false;
            feedback.textContent +=
              " Nothing was accepted for publication; you can revise this draft.";
          }
        } catch {
          /* Outcome is unknown. Preserve the exact request for a safe retry. */
        }
      }
    } finally {
      saving = false;
      save.disabled = false;
      if (!submitted) {
        for (const control of controls.filter((c) => c !== type)) {
          control.disabled = false;
        }
        type.disabled = Boolean(base);
      }
      if (dialog.isConnected) {
        persist();
      }
    }
  };
  form.addEventListener("submit", (event) => {
    void submit(event);
  });
  return {
    reopen() {
      if (!dialog.open) {
        reopen.hidden = true;
        dialog.showModal();
      }
    },
  };
}
