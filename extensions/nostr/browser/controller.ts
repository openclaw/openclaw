import type {
  ControlUiChannelSettingsContext,
  ControlUiChannelSettingsSnapshot,
} from "openclaw/plugin-sdk/control-ui";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Translator } from "./i18n/index.ts";
import { createNostrProfileFormState, type NostrProfileFormState } from "./profile-form.tsx";
import type { NostrProfile } from "./types.ts";

const NOSTR_PROFILE_REQUEST_TIMEOUT_MS = 30_000;

function parseValidationErrors(
  details: unknown,
  formatExternalText: (text: string) => string,
): Record<string, string> {
  if (!Array.isArray(details)) {
    return {};
  }
  const errors: Record<string, string> = {};
  for (const entry of details) {
    if (typeof entry !== "string") {
      continue;
    }
    const [rawField, ...rest] = entry.split(":");
    if (!rawField || rest.length === 0) {
      continue;
    }
    const field = rawField.trim();
    const message = rest.join(":").trim();
    if (field && message) {
      errors[field] = formatExternalText(message);
    }
  }
  return errors;
}

function isNostrProfile(value: unknown): value is NostrProfile {
  return (
    isRecord(value) &&
    ["name", "displayName", "about", "picture", "banner", "website", "nip05", "lud16"].every(
      (field) =>
        value[field] === undefined || value[field] === null || typeof value[field] === "string",
    )
  );
}

/** Form identity settles synchronously; rendering consumes this plugin-owned state. */
export function createProfileController(
  context: ControlUiChannelSettingsContext,
  notify: () => void,
  t: Translator,
) {
  let snapshot = context.props;
  let form: NostrProfileFormState | null = null;
  let accountId: string | null = null;
  let operation: AbortController | undefined;
  let disposed = false;
  function cancelOperation() {
    operation?.abort();
    operation = undefined;
  }
  function editForm(update: (current: NostrProfileFormState) => NostrProfileFormState) {
    if (!disposed && form) {
      form = update(form);
      notify();
    }
  }
  async function updateProfile(action: "save" | "import") {
    if (
      disposed ||
      context.signal.aborted ||
      !snapshot.connected ||
      !snapshot.canAdmin ||
      !form ||
      form.saving ||
      form.importing
    ) {
      return;
    }
    cancelOperation();
    const current = new AbortController();
    operation = current;
    const submitted = form;
    const isCurrent = () => !disposed && !context.signal.aborted && operation === current;
    const busy = action === "save" ? "saving" : "importing";
    editForm((value) => ({
      ...value,
      [busy]: true,
      error: null,
      success: null,
      ...(action === "save" ? { fieldErrors: {} } : {}),
    }));
    try {
      const targetAccountId = accountId ?? snapshot.accounts[0]?.accountId ?? "default";
      async function requestProfile(
        method: "PUT" | "POST",
        body: unknown,
        suffix: readonly string[] = [],
      ) {
        const controller = new AbortController();
        const timeout = setTimeout(
          () =>
            controller.abort(
              new DOMException("Nostr profile request timed out after 30 seconds", "TimeoutError"),
            ),
          NOSTR_PROFILE_REQUEST_TIMEOUT_MS,
        );
        try {
          return await context.request({
            accountId: targetAccountId,
            path: ["profile", ...suffix],
            method,
            body,
            signal: AbortSignal.any([current.signal, controller.signal]),
          });
        } finally {
          clearTimeout(timeout);
        }
      }
      async function importProfile() {
        const result = await requestProfile("POST", { autoMerge: true }, ["import"]);
        return {
          ...result,
          data: result.data && {
            ...result.data,
            ok: result.data.ok,
            saved: result.data.saved,
            imported: isNostrProfile(result.data.imported) ? result.data.imported : undefined,
            merged: isNostrProfile(result.data.merged) ? result.data.merged : undefined,
          },
        };
      }
      const result =
        action === "save"
          ? { action, ...(await requestProfile("PUT", submitted.values)) }
          : { action, ...(await importProfile()) };
      if (!isCurrent() || !form) {
        return;
      }
      const settled = { ...form, [busy]: false, error: null, success: null };
      if (!result.ok || result.data?.ok === false || !result.data) {
        form = {
          ...settled,
          error: result.errorMessage,
          ...(result.action === "save"
            ? {
                fieldErrors: parseValidationErrors(
                  result.data?.details,
                  context.formatExternalText,
                ),
              }
            : {}),
        };
      } else if (result.action === "save") {
        form = result.data.persisted
          ? {
              ...settled,
              success: t("channels.nostr.notices.published"),
              fieldErrors: {},
              original: { ...submitted.values },
            }
          : { ...settled, error: t("channels.nostr.notices.publishFailed") };
      } else {
        const merged = result.data.merged ?? result.data.imported ?? null;
        const values = merged ? { ...form.values, ...merged } : form.values;
        form = {
          ...settled,
          values,
          success: t(
            result.data.saved
              ? "channels.nostr.notices.importedFromRelays"
              : "channels.nostr.notices.imported",
          ),
          showAdvanced: Boolean(values.banner || values.website || values.nip05 || values.lud16),
        };
      }
      notify();
      if (!form.error && (result.action === "save" || result.data?.saved)) {
        await context.refresh(true);
      }
    } catch (error) {
      // Retired callbacks must not call even the host's lifetime-bound error formatter.
      if (!isCurrent()) {
        return;
      }
      editForm((value) => ({
        ...value,
        [busy]: false,
        success: null,
        error:
          error instanceof DOMException && error.name === "TimeoutError"
            ? t("channels.nostr.notices.timeout")
            : t("channels.nostr.notices.operationFailed", {
                prefix: t(
                  action === "save"
                    ? "channels.nostr.notices.updateFailed"
                    : "channels.nostr.notices.importFailed",
                ),
                error: context.formatError(error),
              }),
      }));
    }
  }
  function dispose() {
    disposed = true;
    cancelOperation();
    context.signal.removeEventListener("abort", dispose);
  }
  context.signal.addEventListener("abort", dispose, { once: true });
  return {
    read: () => ({ snapshot, form, accountId }),
    update(next: ControlUiChannelSettingsSnapshot) {
      if (disposed) {
        return;
      }
      if (
        snapshot.connectionEpoch !== next.connectionEpoch ||
        snapshot.connected !== next.connected
      ) {
        cancelOperation();
        if (form) {
          form = { ...form, saving: false, importing: false };
        }
      }
      snapshot = next;
      notify();
    },
    edit(nextAccountId: string, profile: NostrProfile | null) {
      if (disposed) {
        return;
      }
      cancelOperation();
      accountId = nextAccountId;
      form = createNostrProfileFormState(profile ?? undefined);
      notify();
    },
    cancel() {
      if (!disposed) {
        cancelOperation();
        form = null;
        accountId = null;
        notify();
      }
    },
    field(field: keyof NostrProfile, value: string) {
      editForm((state) => ({
        ...state,
        values: { ...state.values, [field]: value },
        fieldErrors: { ...state.fieldErrors, [field]: "" },
      }));
    },
    toggleAdvanced() {
      editForm((state) => ({ ...state, showAdvanced: !state.showAdvanced }));
    },
    save: () => updateProfile("save"),
    import: () => updateProfile("import"),
    dispose,
  };
}
