import { afterAll, afterEach, vi } from "vitest";

const attachmentLookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return {
    ...actual,
    lookup: (...args: Parameters<typeof actual.lookup>) =>
      attachmentLookup.getMockImplementation() ? attachmentLookup(...args) : actual.lookup(...args),
  };
});

export type AttachmentTestTransport = {
  fetchFn?: typeof fetch;
  resolveFn?: (hostname: string) => Promise<{ address: string }>;
};

export function useAttachmentTestTransport() {
  // Cached production namespaces may retain lookup after this suite. Restore
  // native behavior rather than leaving an empty mock or splitting identities.
  afterEach(() => {
    vi.unstubAllGlobals();
    attachmentLookup.mockReset();
  });
  afterAll(() => attachmentLookup.mockReset());
  return installAttachmentTestTransport;
}

function installAttachmentTestTransport({
  fetchFn,
  resolveFn = async () => ({ address: "13.107.136.10" }),
}: AttachmentTestTransport) {
  if (fetchFn) {
    vi.stubGlobal("fetch", fetchFn);
  }
  attachmentLookup.mockImplementation(async (hostname: string, options?: { all?: boolean }) => {
    const resolved = await resolveFn(hostname);
    const address = { ...resolved, family: resolved.address.includes(":") ? 6 : 4 };
    return options?.all ? [address] : address;
  });
}
