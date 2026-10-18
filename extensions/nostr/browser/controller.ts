import type {
  ControlUiChannelSettingsContext,
  ControlUiChannelSettingsSnapshot,
} from "openclaw/plugin-sdk/control-ui";
import type { Translator } from "./i18n/index.ts";
import { createNostrProfileFormState, type NostrProfileFormState } from "./profile-form.tsx";
import { importNostrProfile, parseValidationErrors, putNostrProfile } from "./profile-ops.ts";
import type { NostrProfile } from "./types.ts";

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
      const request = {
        context,
        accountId: accountId ?? snapshot.accounts[0]?.accountId ?? "default",
        signal: current.signal,
      };
      const result =
        action === "save"
          ? { action, ...(await putNostrProfile({ ...request, values: submitted.values })) }
          : { action, ...(await importNostrProfile(request)) };
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
