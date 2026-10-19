import type {
  ControlUiChannelSettingsContext,
  ControlUiChannelSettingsSnapshot,
} from "openclaw/plugin-sdk/control-ui";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { settingsViews } from "./index.tsx";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const stop of cleanups.splice(0)) {
    stop();
  }
  document.body.replaceChildren();
  vi.useRealTimers();
});
const ok = (data: Record<string, unknown>) => ({
  ok: true,
  status: 200,
  data,
  errorMessage: "HTTP 200",
});
async function settle() {
  flush();
  await Promise.resolve();
  await Promise.resolve();
  flush();
}
function fixture() {
  const abort = new AbortController();
  let snapshot: ControlUiChannelSettingsSnapshot = {
    channelId: "nostr",
    status: { configured: true, running: true, profile: { name: "Alice" } },
    accounts: [],
    connected: true,
    canAdmin: true,
    connectionEpoch: 1,
    locale: "en",
    presented: true,
  };
  const unavailable = () => {
    throw new Error("Nostr's native markup does not mount generic Settings widgets");
  };
  const request = vi
    .fn<ControlUiChannelSettingsContext["request"]>()
    .mockResolvedValue(ok({ ok: true, persisted: true }));
  const refresh = vi.fn<ControlUiChannelSettingsContext["refresh"]>().mockResolvedValue();
  const formatError = vi.fn((error: unknown) => String(error));
  const context: ControlUiChannelSettingsContext = {
    props: snapshot,
    signal: abort.signal,
    components: {
      mountSection: unavailable,
      mountRow: unavailable,
      mountStatus: unavailable,
      mountValue: unavailable,
      mountNavigation: unavailable,
      mountLobster: unavailable,
    },
    request,
    refresh,
    formatError,
    formatExternalText: (text) => text,
    formatRelativeTimestamp: () => "recently",
    mountConfig: () => () => {},
  };
  const container = document.createElement("div");
  document.body.append(container);
  const mounted = settingsViews[0]!.mount(container, context);
  cleanups.push(() => {
    abort.abort();
    mounted.dispose();
    container.remove();
  });
  flush();
  function button(label: string) {
    const node = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!node) {
      throw new Error(`Missing button ${label}`);
    }
    return node;
  }
  function field(name: string, value: string) {
    const input = container.querySelector<HTMLInputElement>(`#nostr-profile-${name}`)!;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    return input;
  }
  function update(patch: Partial<ControlUiChannelSettingsSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    mounted.update(snapshot);
    flush();
  }
  button("Edit Profile").click();
  flush();
  field("name", "Alice Updated");
  return { container, abort, request, refresh, formatError, button, field, update };
}

it("keeps the actual editor node while replacing its draft and calls the current save action", async () => {
  const f = fixture();
  const input = f.container.querySelector<HTMLInputElement>("#nostr-profile-name")!;
  expect(input.value).toBe("Alice Updated");
  f.field("name", "after");
  expect(f.container.querySelector("#nostr-profile-name")).toBe(input);
  expect(input.value).toBe("after");
  expect(f.container.textContent).toContain("You have unsaved changes");
  f.button("Save & Publish").click();
  await settle();
  expect(f.request).toHaveBeenCalledOnce();
  expect(f.request).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: "default",
      path: ["profile"],
      method: "PUT",
      body: expect.objectContaining({ name: "after" }),
    }),
  );
  expect(f.container.textContent).toContain("Profile published to relays.");
  expect(f.button("Save & Publish").disabled).toBe(true);
  expect(f.refresh).toHaveBeenCalledWith(true);
});

it("preserves null imported names and extra profile metadata", async () => {
  const f = fixture();
  f.request.mockResolvedValue(
    ok({
      ok: true,
      saved: true,
      merged: { name: null, displayName: "Imported display", extra: { value: true } },
    }),
  );
  f.button("Import from Relays").click();
  await vi.waitFor(() => {
    flush();
    expect(f.container.textContent).toContain("Profile imported from relays. Review and publish.");
  });
  expect(f.container.querySelector<HTMLInputElement>("#nostr-profile-name")!.value).toBe("");
  expect(f.container.querySelector<HTMLInputElement>("#nostr-profile-displayName")!.value).toBe(
    "Imported display",
  );
  expect(f.container.textContent).toContain("Profile imported from relays. Review and publish.");
  expect(f.refresh).toHaveBeenCalledWith(true);
});

it("merges an import into the live draft and reveals imported advanced fields", async () => {
  const f = fixture();
  const pending = createDeferred<Awaited<ReturnType<ControlUiChannelSettingsContext["request"]>>>();
  f.request.mockReturnValue(pending.promise);
  f.button("Import from Relays").click();
  flush();
  f.field("displayName", "Typed during import");
  pending.resolve(ok({ ok: true, imported: { name: "Imported", website: "https://example.com" } }));
  await vi.waitFor(() => {
    flush();
    expect(f.container.textContent).toContain("Profile imported. Review and publish.");
  });
  expect(f.container.querySelector<HTMLInputElement>("#nostr-profile-displayName")!.value).toBe(
    "Typed during import",
  );
  expect(f.container.querySelector<HTMLInputElement>("#nostr-profile-website")!.value).toBe(
    "https://example.com",
  );
  expect(f.container.textContent).toContain("Profile imported. Review and publish.");
  expect(f.refresh).not.toHaveBeenCalled();
});

it("renders validation details and clears a field error on editing", async () => {
  const f = fixture();
  f.request.mockResolvedValue({
    ok: false,
    status: 400,
    data: { ok: false, details: ["name: Name is too long"] },
    errorMessage: "HTTP 400: Validation failed",
  });
  f.button("Save & Publish").click();
  await settle();
  expect(f.container.querySelector('[role="alert"]')?.textContent).toContain(
    "HTTP 400: Validation failed",
  );
  expect(f.container.textContent).toContain("Name is too long");
  expect(f.container.querySelector("#nostr-profile-name")?.getAttribute("aria-invalid")).toBe(
    "true",
  );
  f.field("name", "Short");
  expect(f.container.textContent).not.toContain("Name is too long");
  expect(f.refresh).not.toHaveBeenCalled();
});

it("keeps failed publication dirty without refreshing channel status", async () => {
  const f = fixture();
  f.request.mockResolvedValue(ok({ ok: true, persisted: false }));
  f.button("Save & Publish").click();
  await settle();
  expect(f.container.textContent).toContain("Profile publish failed on all relays.");
  expect(f.button("Save & Publish").disabled).toBe(false);
  expect(f.refresh).not.toHaveBeenCalled();
});

it.each(["Save & Publish", "Import from Relays"])(
  "applies one 30-second deadline and recovers rendered %s",
  async (action) => {
    vi.useFakeTimers();
    const f = fixture();
    f.request.mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              try {
                signal.throwIfAborted();
              } catch (error) {
                reject(
                  error instanceof Error || error instanceof DOMException
                    ? error
                    : new Error("Unexpected abort reason", { cause: error }),
                );
              }
            },
            { once: true },
          );
        }),
    );
    f.button(action).click();
    flush();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.container.textContent).not.toContain("Request timed out");
    expect(f.request.mock.calls[0]![0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(f.request.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(f.button(action).disabled).toBe(false);
    expect(f.container.textContent).toContain(
      "Request timed out after 30 seconds; the server may still have applied the change — check the profile before retrying.",
    );
    expect(f.refresh).not.toHaveBeenCalled();
  },
);

it.each(["disconnect", "replacement form", "abort"] as const)(
  "drops late import success and failure after %s before host formatting",
  async (retirement) => {
    const f = fixture();
    const pending =
      createDeferred<Awaited<ReturnType<ControlUiChannelSettingsContext["request"]>>>();
    f.request.mockReturnValueOnce(pending.promise);
    f.button("Import from Relays").click();
    flush();
    if (retirement === "disconnect") {
      f.update({ connected: false, connectionEpoch: 2 });
      expect(f.button("Save & Publish").disabled).toBe(true);
      expect(f.button("Import from Relays").disabled).toBe(true);
    } else if (retirement === "replacement form") {
      f.button("Cancel").click();
      flush();
      f.button("Edit Profile").click();
      flush();
      f.field("name", "Fresh draft");
    } else {
      f.abort.abort();
    }
    expect(f.request.mock.calls[0]![0].signal.aborted).toBe(true);
    pending.resolve(ok({ ok: true, saved: true, merged: { name: "Stale import" } }));
    await settle();
    expect(f.container.textContent).not.toContain("Profile imported");
    expect(f.container.textContent).not.toContain("Last error");
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.formatError).not.toHaveBeenCalled();
    if (retirement === "disconnect") {
      expect(f.container.querySelector<HTMLInputElement>("#nostr-profile-name")!.value).toBe(
        "Alice Updated",
      );
      f.update({ connected: true, connectionEpoch: 3 });
      expect(f.button("Import from Relays").disabled).toBe(false);
    } else if (retirement === "replacement form") {
      expect(f.container.querySelector<HTMLInputElement>("#nostr-profile-name")!.value).toBe(
        "Fresh draft",
      );
    }
  },
);

it("does not format a late failure after the view aborts", async () => {
  const f = fixture();
  const pending = createDeferred<Awaited<ReturnType<ControlUiChannelSettingsContext["request"]>>>();
  f.request.mockReturnValue(pending.promise);
  f.button("Save & Publish").click();
  f.abort.abort();
  pending.reject(new Error("late failure"));
  await settle();
  expect(f.formatError).not.toHaveBeenCalled();
  expect(f.refresh).not.toHaveBeenCalled();
});

it("settles while hidden and catches the retained editor up once on reveal", async () => {
  const f = fixture();
  const pending = createDeferred<Awaited<ReturnType<ControlUiChannelSettingsContext["request"]>>>();
  f.request.mockReturnValue(pending.promise);
  f.button("Import from Relays").click();
  flush();
  f.update({ presented: false });
  pending.resolve(ok({ ok: true, saved: false, merged: { name: "Imported while hidden" } }));
  await settle();
  expect(f.container.querySelector<HTMLInputElement>("#nostr-profile-name")!.value).toBe(
    "Alice Updated",
  );
  f.update({ presented: true });
  expect(f.container.querySelector<HTMLInputElement>("#nostr-profile-name")!.value).toBe(
    "Imported while hidden",
  );
  expect(f.container.textContent).toContain("Profile imported.");
});
