import { describe, expect, it } from "vitest";
import {
  consumePendingToolMediaIntoReply,
  readPendingToolMediaReply,
  restorePendingToolMediaReply,
} from "./embedded-agent-subscribe.handlers.messages.replies.js";

describe("consumePendingToolMediaIntoReply", () => {
  it("attaches queued tool media to the next assistant reply", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/a.png", "/tmp/a.png", "/tmp/b.png"],
      pendingToolMediaAttachments: [
        { type: "image" as const, path: "/tmp/a.png", width: 640, height: 480 },
        { type: "image" as const, path: "/tmp/a.png", width: 1, height: 1 },
        { type: "image" as const, path: "/tmp/b.png", width: 800, height: 600 },
      ],
      pendingToolMediaTrustByUrl: new Map([
        ["/tmp/a.png", true],
        ["/tmp/b.png", false],
      ]),
      pendingToolAudioAsVoice: false,
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "done",
      }),
    ).toEqual({
      text: "done",
      mediaUrls: ["/tmp/a.png", "/tmp/b.png"],
      attachments: [
        {
          type: "image",
          path: "/tmp/a.png",
          width: 640,
          height: 480,
          trustedLocalMedia: true,
        },
        { type: "image", path: "/tmp/b.png", width: 800, height: 600 },
      ],
      audioAsVoice: undefined,
    });
    expect(state.pendingToolMediaUrls).toStrictEqual([]);
    expect(state.pendingToolMediaAttachments).toStrictEqual([]);
  });

  it("retains queued metadata for explicitly selected media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/generated.mp3", "/tmp/generated.mp3", "/tmp/unselected.mp3"],
      pendingToolMediaAttachments: [
        { type: "audio" as const, path: "/tmp/generated.mp3", durationMs: 2_000 },
        { type: "audio" as const, path: "/tmp/generated.mp3", durationMs: 9_999 },
        { type: "audio" as const, path: "/tmp/unselected.mp3", durationMs: 3_000 },
      ],
      pendingToolMediaTrustByUrl: new Map([
        ["/tmp/generated.mp3", true],
        ["/tmp/unselected.mp3", false],
      ]),
      pendingToolAudioAsVoice: false,
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "done",
        mediaUrls: [" /tmp/generated.mp3 "],
      }),
    ).toEqual({
      text: "done",
      mediaUrls: [" /tmp/generated.mp3 "],
      attachments: [
        {
          type: "audio",
          path: "/tmp/generated.mp3",
          durationMs: 2_000,
          trustedLocalMedia: true,
        },
      ],
      trustedLocalMedia: true,
    });
    expect(state.pendingToolMediaAttachments).toStrictEqual([]);
  });

  it("does not trust an explicitly selected untrusted pending URL", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/generated.mp3", "/tmp/untrusted.mp3"],
      pendingToolMediaAttachments: [
        { type: "audio" as const, path: "/tmp/generated.mp3" },
        {
          type: "audio" as const,
          path: "/tmp/untrusted.mp3",
          trustedLocalMedia: true,
        },
      ],
      pendingToolMediaTrustByUrl: new Map([
        ["/tmp/generated.mp3", true],
        ["/tmp/untrusted.mp3", false],
      ]),
      pendingToolAudioAsVoice: false,
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "done",
        mediaUrls: ["/tmp/untrusted.mp3"],
      }),
    ).toEqual({
      text: "done",
      mediaUrls: ["/tmp/untrusted.mp3"],
      attachments: [{ type: "audio", path: "/tmp/untrusted.mp3" }],
    });
  });

  it("does not append queued voice media when the reply already names media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/reply.opus"],
      pendingToolMediaTrustByUrl: new Map([["/tmp/reply.opus", true]]),
      pendingToolAudioAsVoice: true,
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "done",
        mediaUrls: ["/tmp/assistant-provided.opus"],
      }),
    ).toEqual({
      text: "done",
      mediaUrls: ["/tmp/assistant-provided.opus"],
    });
    expect(state.pendingToolMediaUrls).toStrictEqual([]);
    expect(state.pendingToolAudioAsVoice).toBe(false);
    expect(state.pendingToolMediaTrustByUrl.size).toBe(0);
  });

  it("preserves reasoning replies without consuming queued media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/a.png"],
      pendingToolMediaTrustByUrl: new Map([["/tmp/a.png", false]]),
      pendingToolAudioAsVoice: true,
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "thinking",
        isReasoning: true,
      }),
    ).toEqual({
      text: "thinking",
      isReasoning: true,
    });
    expect(state.pendingToolMediaUrls).toEqual(["/tmp/a.png"]);
    expect(state.pendingToolAudioAsVoice).toBe(true);
  });
});

describe("pending tool-media reply ownership", () => {
  it("omits queued tool media delivered to the current reply route", () => {
    const state = {
      pendingToolMediaUrls: ["file:///tmp/already-sent.jpg", "/tmp/keep.jpg"],
      pendingToolMediaAttachments: [
        { type: "image" as const, path: "/tmp/already-sent.jpg" },
        { type: "image" as const, path: "/tmp/keep.jpg" },
      ],
      pendingToolMediaTrustByUrl: new Map([
        ["file:///tmp/already-sent.jpg", true],
        ["/tmp/keep.jpg", false],
      ]),
      pendingToolAudioAsVoice: false,
      messagingToolSentMediaUrls: ["/tmp/already-sent.jpg"],
      currentSourceMessagingToolSentMediaUrls: ["/tmp/already-sent.jpg"],
      messagingToolSentTargets: [
        {
          tool: "message",
          provider: "slack",
          to: "channel:C1",
          mediaUrls: ["/tmp/already-sent.jpg"],
        },
      ],
    };

    expect(readPendingToolMediaReply(state)).toEqual({
      mediaUrls: ["/tmp/keep.jpg"],
      attachments: [{ type: "image", path: "/tmp/keep.jpg" }],
      audioAsVoice: undefined,
    });
  });

  it("preserves queued tool media already delivered to a different route", () => {
    const state = {
      pendingToolMediaUrls: ["file:///tmp/already-sent.jpg"],
      pendingToolMediaAttachments: [{ type: "image" as const, path: "/tmp/already-sent.jpg" }],
      pendingToolMediaTrustByUrl: new Map([["file:///tmp/already-sent.jpg", true]]),
      pendingToolAudioAsVoice: false,
      messagingToolSentMediaUrls: ["/tmp/already-sent.jpg"],
      currentSourceMessagingToolSentMediaUrls: [],
      messagingToolSentTargets: [
        {
          tool: "message",
          provider: "discord",
          to: "channel:C2",
          mediaUrls: ["/tmp/already-sent.jpg"],
        },
      ],
    };

    expect(readPendingToolMediaReply(state)).toEqual({
      mediaUrls: ["file:///tmp/already-sent.jpg"],
      attachments: [{ type: "image", path: "/tmp/already-sent.jpg", trustedLocalMedia: true }],
      audioAsVoice: undefined,
      trustedLocalMedia: true,
    });
  });

  it("does not return a voice-only reply when all queued media was already delivered", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/already-sent.opus"],
      pendingToolMediaAttachments: [{ type: "audio" as const, path: "/tmp/already-sent.opus" }],
      pendingToolMediaTrustByUrl: new Map([["/tmp/already-sent.opus", true]]),
      pendingToolAudioAsVoice: true,
      messagingToolSentMediaUrls: ["/tmp/already-sent.opus"],
      currentSourceMessagingToolSentMediaUrls: ["/tmp/already-sent.opus"],
      messagingToolSentTargets: [
        {
          tool: "message",
          provider: "whatsapp",
          to: "group-1",
          mediaUrls: ["/tmp/already-sent.opus"],
        },
      ],
    };

    expect(readPendingToolMediaReply(state)).toBeNull();
  });

  it("reads a media-only reply without consuming queued tool media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/reply.opus"],
      pendingToolMediaTrustByUrl: new Map([["/tmp/reply.opus", false]]),
      pendingToolAudioAsVoice: true,
    };

    expect(readPendingToolMediaReply(state)).toEqual({
      mediaUrls: ["/tmp/reply.opus"],
      audioAsVoice: true,
    });
    expect(state.pendingToolMediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(state.pendingToolAudioAsVoice).toBe(true);
  });

  it("restores rejected media before newer pending media without widening trust", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/newer.png"],
      pendingToolMediaAttachments: [{ type: "image" as const, path: "/tmp/newer.png" }],
      pendingToolMediaTrustByUrl: new Map([["/tmp/newer.png", false]]),
      pendingToolAudioAsVoice: false,
      pendingToolMediaDeliveryFailed: false,
    };

    restorePendingToolMediaReply(state, {
      mediaUrls: ["/tmp/trusted.opus", "/tmp/untrusted.opus"],
      attachments: [
        { path: "/tmp/trusted.opus", mimeType: "audio/ogg", trustedLocalMedia: true },
        { path: "/tmp/untrusted.opus", mimeType: "audio/ogg" },
      ],
      audioAsVoice: true,
    });

    expect(readPendingToolMediaReply(state)).toEqual({
      mediaUrls: ["/tmp/trusted.opus", "/tmp/untrusted.opus", "/tmp/newer.png"],
      attachments: [
        { path: "/tmp/trusted.opus", mimeType: "audio/ogg", trustedLocalMedia: true },
        { path: "/tmp/untrusted.opus", mimeType: "audio/ogg" },
        { type: "image", path: "/tmp/newer.png" },
      ],
      audioAsVoice: true,
    });
    expect(state.pendingToolMediaTrustByUrl).toEqual(
      new Map([
        ["/tmp/newer.png", false],
        ["/tmp/trusted.opus", true],
        ["/tmp/untrusted.opus", false],
      ]),
    );
    expect(state.pendingToolMediaDeliveryFailed).toBe(true);
  });
});
