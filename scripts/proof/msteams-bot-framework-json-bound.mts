// Real behavior proof: MSTeams Bot Framework attachmentInfo fetch bounds
// the JSON response so an oversized body cannot OOM the runtime.
//
// The proof installs the MSTeams runtime, then calls
// `downloadMSTeamsBotFrameworkAttachment` with a `fetchFn` that returns an
// attachmentInfo response larger than the 64 KiB cap. With the fix the
// function returns undefined and logs a parse warning; without the bound the
// runtime would buffer the entire oversized body before parsing.

import { setMSTeamsRuntime } from "../../extensions/msteams/src/runtime.js";
import { downloadMSTeamsBotFrameworkAttachment } from "../../extensions/msteams/src/attachments/bot-framework.js";

const hugeBody = JSON.stringify({
  name: "doc.pdf",
  type: "application/pdf",
  views: [{ viewId: "original", size: 10 }],
  padding: "x".repeat(128 * 1024),
});

setMSTeamsRuntime({
  media: {
    detectMime: async ({ headerMime }: { headerMime?: string }) => headerMime ?? "application/pdf",
  },
  channel: {
    media: {
      saveMediaBuffer: async () => ({ path: "/tmp/bf-attachment.bin", contentType: "application/pdf" }),
      readRemoteMediaBuffer: async () => ({ buffer: Buffer.alloc(0), contentType: undefined }),
      saveRemoteMedia: async () => ({ path: "/tmp/bf-attachment.bin", contentType: "application/pdf" }),
      saveResponseMedia: async () => ({
        path: "/tmp/bf-attachment.bin",
        contentType: "application/pdf",
      }),
    },
  },
} as never);

console.log("=== Proof: MSTeams Bot Framework attachmentInfo JSON bound ===\n");

const warnings: string[] = [];

try {
  const media = await downloadMSTeamsBotFrameworkAttachment({
    serviceUrl: "https://smba.trafficmanager.net/amer",
    attachmentId: "att-1",
    tokenProvider: {
      getAccessToken: async () => "bf-token",
    },
    maxBytes: 10_000_000,
    fetchFn: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(hugeBody));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    fetchFnSupportsDispatcher: true,
    resolveFn: async () => ({ address: "93.184.216.34" }),
    logger: {
      warn: (msg: string) => {
        warnings.push(msg);
      },
    },
  });

  if (media === undefined && warnings.includes("msteams botFramework attachmentInfo parse failed")) {
    console.log("PASS: oversized attachmentInfo JSON response was rejected without OOM.");
  } else {
    console.log("FAIL: unexpected result:", { media, warnings });
    process.exitCode = 1;
  }
} catch (err) {
  console.error("FAIL: handler threw:", err);
  process.exitCode = 1;
}
