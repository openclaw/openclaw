import { beforeEach, expect, it, vi } from "vitest";
import { cookiesGetViaPlaywright } from "./pw-tools-core.storage.js";

const fixture = vi.hoisted(() => ({
  cookies: vi.fn(),
  send: vi.fn(),
  detach: vi.fn(async () => {}),
}));
vi.mock("./pw-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pw-session.js")>()),
  getPageForTargetId: vi.fn(async () => ({
    context: () => ({
      cookies: fixture.cookies,
      newCDPSession: async () => ({ send: fixture.send, detach: fixture.detach }),
    }),
  })),
}));
const ordinary = {
  name: "session",
  value: "synthetic",
  domain: ".example.test",
  path: "/",
  expires: 1900000000.25,
  httpOnly: true,
  secure: true,
  sameSite: "None",
  session: false,
  priority: "High",
  sourceScheme: "Secure",
  sourcePort: 443,
};
const options = {
  cdpUrl: "http://127.0.0.1:9222",
  targetId: "selected",
  partition: "unpartitioned" as const,
};
beforeEach(() => {
  vi.clearAllMocks();
  fixture.cookies.mockResolvedValue([ordinary]);
});

it("excludes whole partition namespaces before lossy normalization, including false marker presence", async () => {
  const metadata = [
    { partitionKey: { topLevelSite: "https://one.test", hasCrossSiteAncestor: false } },
    { partitionKey: { topLevelSite: "https://two.test", hasCrossSiteAncestor: true } },
    { partitionKeyOpaque: true },
    { partitionKeyOpaque: false },
    ...[undefined, null, "", "https://one.test", false, 0, [], {}].map((partitionKey) => ({
      partitionKey,
    })),
    ...[undefined, null, "false", 0, [], {}].map((partitionKeyOpaque) => ({ partitionKeyOpaque })),
  ];
  fixture.send.mockResolvedValue({
    cookies: [ordinary, ...metadata.map((m) => Object.assign({}, ordinary, m))],
  });
  expect(await cookiesGetViaPlaywright(options)).toEqual({
    cookies: [ordinary],
    cookiePartition: "unpartitioned",
  });
  expect(fixture.cookies).not.toHaveBeenCalled();
  expect(fixture.detach).toHaveBeenCalledOnce();
  for (const marker of [{ partitionKeyOpaque: false }, { partitionKeyOpaque: true }]) {
    fixture.send.mockResolvedValueOnce({ cookies: [{ ...ordinary, ...marker }] });
    expect(await cookiesGetViaPlaywright(options)).toEqual({
      cookies: [],
      cookiePartition: "unpartitioned",
    });
  }
  expect(await cookiesGetViaPlaywright({ cdpUrl: options.cdpUrl })).toEqual({
    cookies: [ordinary],
  });
});

it.each([null, {}, { cookies: null }, { cookies: [null] }, { cookies: [42] }])(
  "fails closed on malformed protocol response %j",
  async (reply) => {
    fixture.send.mockResolvedValue(reply);
    await expect(cookiesGetViaPlaywright(options)).rejects.toThrow();
    expect(fixture.detach).toHaveBeenCalledOnce();
  },
);

it("does not publish cookies after cancellation or authority loss during acquisition", async () => {
  const controller = new AbortController();
  fixture.send.mockImplementationOnce(async () => {
    controller.abort(new Error("capture ended"));
    return { cookies: [ordinary] };
  });
  await expect(cookiesGetViaPlaywright({ ...options, signal: controller.signal })).rejects.toThrow(
    "capture ended",
  );
  let current = true;
  fixture.send.mockImplementationOnce(async () => {
    current = false;
    return { cookies: [ordinary] };
  });
  await expect(
    cookiesGetViaPlaywright({
      ...options,
      assertCurrent: () => {
        if (!current) {
          throw new Error("authority ended");
        }
      },
    }),
  ).rejects.toThrow("authority ended");
});
