import type {
  ControlUiChannelSettingsContext as Context,
  ControlUiChannelSettingsSnapshot as Snapshot,
} from "openclaw/plugin-sdk/control-ui";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { settingsViews } from "./index.tsx";

afterEach(() => {
  f.abort.abort();
  f.mounted.dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
});
function ok(data: Record<string, unknown>) {
  return { ok: true, status: 200, data, errorMessage: "HTTP 200" };
}
async function settle() {
  flush();
  await Promise.resolve();
  await Promise.resolve();
  flush();
}
class ProfileFixture {
  abort = new AbortController();
  container = document.createElement("div");
  request = vi.fn<Context["request"]>();
  refresh = vi.fn<Context["refresh"]>().mockResolvedValue();
  formatError = vi.fn((error: unknown) => String(error));
  snapshot: Snapshot = {
    channelId: "nostr",
    status: { configured: true, running: true, profile: { name: "Alice" } },
    accounts: [],
    connected: true,
    canAdmin: true,
    connectionEpoch: 1,
    locale: "en",
    presented: true,
  };
  mounted;
  constructor() {
    const unavailable = () => {
      throw new Error("Nostr's native markup does not mount generic Settings widgets");
    };
    document.body.append(this.container);
    this.mounted = settingsViews[0]!.mount(this.container, {
      props: this.snapshot,
      signal: this.abort.signal,
      components: {
        mountSection: unavailable,
        mountRow: unavailable,
        mountStatus: unavailable,
        mountValue: unavailable,
        mountNavigation: unavailable,
        mountLobster: unavailable,
      },
      request: this.request,
      refresh: this.refresh,
      formatError: this.formatError,
      formatExternalText: (text) => text,
      formatRelativeTimestamp: () => "recently",
      mountConfig: () => () => {},
    });
    flush();
    this.click("Edit Profile");
    this.field("name", "Alice Updated");
  }
  button(label: string) {
    return [...this.container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    )!;
  }
  field(name: string, value: string) {
    const node = this.input(name);
    node.value = value;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
  }
  input(name: string) {
    return this.container.querySelector<HTMLInputElement>(`#nostr-profile-${name}`)!;
  }
  values(...names: string[]) {
    return Object.fromEntries(names.map((name) => [name, this.input(name).value]));
  }
  click(label: string) {
    this.button(label).click();
    flush();
  }
  pending(action: string) {
    const result = createDeferred<Awaited<ReturnType<Context["request"]>>>();
    this.request.mockReturnValueOnce(result.promise);
    this.click(action);
    return result;
  }
  async waitForText(text: string) {
    await vi.waitFor(() => {
      flush();
      expect(this.container.textContent).toContain(text);
    });
  }
  update(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.mounted.update(this.snapshot);
    flush();
  }
}
let f: ProfileFixture;
beforeEach(() => {
  f = new ProfileFixture();
});

it.each([true, false])("publishes the live draft with persisted=%s", async (persisted) => {
  f.request.mockResolvedValue(ok({ ok: true, persisted }));
  const input = f.input("name");
  f.field("name", "after");
  expect(f.input("name")).toBe(input);
  expect(input.value).toBe("after");
  expect(f.container.textContent).toContain("You have unsaved changes");
  f.click("Save & Publish");
  await settle();
  expect(f.request).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      accountId: "default",
      path: ["profile"],
      method: "PUT",
      body: expect.objectContaining({ name: "after" }),
    }),
  );
  expect(f.container.textContent).toContain(
    persisted ? "Profile published to relays." : "Profile publish failed on all relays.",
  );
  expect(f.button("Save & Publish").disabled).toBe(persisted);
  expect(f.refresh.mock.calls).toEqual(persisted ? [[true]] : []);
});

it.each([
  ["saved", { name: "", displayName: "Imported display" }],
  ["live draft", { displayName: "Typed during import", website: "https://example.com" }],
  ["hidden", { name: "Imported" }],
] as const)("imports into the %s profile", async (mode, expected) => {
  const saved = mode === "saved";
  const hidden = mode === "hidden";
  const pending = f.pending("Import from Relays");
  if (mode === "live draft") {
    f.field("displayName", "Typed during import");
  }
  if (hidden) {
    f.update({ presented: false });
  }
  const profile = saved
    ? { name: null, displayName: "Imported display", extra: { value: true } }
    : { name: "Imported", website: "https://example.com" };
  pending.resolve(
    ok({ ok: true, saved, [mode === "live draft" ? "imported" : "merged"]: profile }),
  );
  if (hidden) {
    await settle();
    expect(f.input("name").value).toBe("Alice Updated");
    f.update({ presented: true });
    expect(f.input("name").value).toBe("Imported");
  }
  const notice = saved ? "Profile imported from relays." : "Profile imported.";
  await f.waitForText(hidden ? notice : `${notice} Review and publish.`);
  expect(f.values(...Object.keys(expected))).toEqual(expected);
  expect(f.refresh.mock.calls).toEqual(saved ? [[true]] : []);
});

it("renders validation details and clears a field error on editing", async () => {
  f.request.mockResolvedValue({
    ok: false,
    status: 400,
    data: { ok: false, details: ["name: Name is too long"] },
    errorMessage: "Invalid profile",
  });
  f.click("Save & Publish");
  await settle();
  expect(f.container.querySelector('[role="alert"]')?.textContent).toContain("Invalid profile");
  expect(f.container.textContent).toContain("Name is too long");
  expect(f.input("name").getAttribute("aria-invalid")).toBe("true");
  f.field("name", "Short");
  expect(f.container.textContent).not.toContain("Name is too long");
  expect(f.refresh).not.toHaveBeenCalled();
});

it.each(["Save & Publish", "Import from Relays"])("times out and recovers %s", async (action) => {
  vi.useFakeTimers();
  const pending = f.pending(action);
  const { signal } = f.request.mock.calls[0]![0];
  signal.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
  await vi.advanceTimersByTimeAsync(29_999);
  expect(f.container.textContent).not.toContain("Request timed out");
  expect(signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await settle();
  expect(signal.aborted).toBe(true);
  expect(f.button(action).disabled).toBe(false);
  expect(f.container.textContent).toContain(
    "Request timed out after 30 seconds; the server may still have applied the change — check the profile before retrying.",
  );
  expect(f.refresh).not.toHaveBeenCalled();
});

it.each(["disconnect", "replacement form", "abort"])("drops imports after %s", async (reason) => {
  const pending = f.pending("Import from Relays");
  if (reason === "disconnect") {
    f.update({ connected: false, connectionEpoch: 2 });
    expect(f.button("Save & Publish").disabled).toBe(true);
    expect(f.button("Import from Relays").disabled).toBe(true);
  } else if (reason === "replacement form") {
    f.click("Cancel");
    f.click("Edit Profile");
    f.field("name", "Fresh draft");
  } else {
    f.abort.abort();
  }
  expect(f.request.mock.calls[0]![0].signal.aborted).toBe(true);
  pending.resolve(ok({ ok: true, saved: true, merged: { name: "Stale import" } }));
  await settle();
  expect(f.container.textContent).not.toMatch(/Profile imported|Last error/);
  expect([f.refresh.mock.calls, f.formatError.mock.calls]).toEqual([[], []]);
  if (reason === "disconnect") {
    expect(f.input("name").value).toBe("Alice Updated");
    f.update({ connected: true, connectionEpoch: 3 });
    expect(f.button("Import from Relays").disabled).toBe(false);
  } else if (reason === "replacement form") {
    expect(f.input("name").value).toBe("Fresh draft");
  }
});

it("does not format a late failure after the view aborts", async () => {
  const pending = f.pending("Save & Publish");
  f.abort.abort();
  pending.reject(new Error("late failure"));
  await settle();
  expect([f.formatError.mock.calls, f.refresh.mock.calls]).toEqual([[], []]);
});
