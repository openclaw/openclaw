#!/usr/bin/env node
// Projection-level proof for chat history inline-media redaction shapes.
// Real gateway endpoint proof lives in
// src/gateway/server-methods/chat-history-inline-media-redaction-request.test.ts
// (real WS `chat.history` + `chat.message.get` over on-disk transcripts).
// Run: node --import tsx scripts/proof-chat-history-sanitize-input-image.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  projectRecentChatDisplayMessages,
  sanitizeChatHistoryMessages,
} from "../src/gateway/chat-display-projection.ts";

function assertDeepEqual(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  console.log(`OK: ${label}`);
}

const REDACT_OPTS = { redactInlineMedia: true };

async function main() {
  const payload = Buffer.from("png-bytes").toString("base64");
  const dataUrl = `data:image/png;base64,${payload}`;

  const inputImageResult = sanitizeChatHistoryMessages(
    [
      {
        role: "assistant",
        content: [{ type: "input_image", image_url: dataUrl }],
        timestamp: 1,
      },
    ],
    undefined,
    REDACT_OPTS,
  );
  assertDeepEqual(
    inputImageResult,
    [
      {
        role: "assistant",
        content: [
          {
            type: "input_image",
            omitted: true,
            bytes: Buffer.byteLength(dataUrl, "utf8"),
          },
        ],
        timestamp: 1,
      },
    ],
    "input_image.image_url data URL redacted",
  );

  const mixedCaseDataUrl = `DATA:image/png;BASE64,${payload}`;
  const mixedCaseInputImageResult = sanitizeChatHistoryMessages(
    [
      {
        role: "assistant",
        content: [{ type: "input_image", image_url: mixedCaseDataUrl }],
        timestamp: 1,
      },
    ],
    undefined,
    REDACT_OPTS,
  );
  assertDeepEqual(
    mixedCaseInputImageResult,
    [
      {
        role: "assistant",
        content: [
          {
            type: "input_image",
            omitted: true,
            bytes: Buffer.byteLength(mixedCaseDataUrl, "utf8"),
          },
        ],
        timestamp: 1,
      },
    ],
    "mixed-case input_image.image_url data URL redacted",
  );

  const imageUrlResult = sanitizeChatHistoryMessages(
    [
      {
        role: "user",
        content: [{ type: "image", url: dataUrl }],
        timestamp: 2,
      },
    ],
    undefined,
    REDACT_OPTS,
  );
  assertDeepEqual(
    imageUrlResult,
    [
      {
        role: "user",
        content: [
          {
            type: "image",
            omitted: true,
            bytes: Buffer.byteLength(dataUrl, "utf8"),
          },
        ],
        timestamp: 2,
      },
    ],
    "image.url data URL redacted",
  );

  const imageData = Buffer.from("png-bytes").toString("base64");
  const imageDataResult = sanitizeChatHistoryMessages([
    {
      role: "assistant",
      content: [{ type: "image", data: imageData }],
      timestamp: 3,
    },
  ]);
  assertDeepEqual(
    imageDataResult,
    [
      {
        role: "assistant",
        content: [
          {
            type: "image",
            omitted: true,
            bytes: Buffer.byteLength(imageData, "utf8"),
          },
        ],
        timestamp: 3,
      },
    ],
    "image.data base64 still redacted",
  );

  const imageSourceDataResult = sanitizeChatHistoryMessages(
    [
      {
        role: "assistant",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: imageData },
          },
        ],
        timestamp: 4,
      },
    ],
    undefined,
    REDACT_OPTS,
  );
  assertDeepEqual(
    imageSourceDataResult,
    [
      {
        role: "assistant",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              omitted: true,
              bytes: Buffer.byteLength(imageData, "utf8"),
            },
          },
        ],
        timestamp: 4,
      },
    ],
    "image.source.data redacted",
  );

  const nestedImageUrlResult = sanitizeChatHistoryMessages(
    [
      {
        role: "assistant",
        content: [{ type: "input_image", image_url: { url: dataUrl } }],
        timestamp: 5,
      },
    ],
    undefined,
    REDACT_OPTS,
  );
  assertDeepEqual(
    nestedImageUrlResult,
    [
      {
        role: "assistant",
        content: [
          {
            type: "input_image",
            image_url: {
              omitted: true,
              bytes: Buffer.byteLength(dataUrl, "utf8"),
            },
          },
        ],
        timestamp: 5,
      },
    ],
    "input_image.image_url.url data URL redacted",
  );

  const broadcastResult = sanitizeChatHistoryMessages([
    {
      role: "assistant",
      content: [{ type: "input_image", image_url: dataUrl }],
      timestamp: 6,
    },
  ]);
  assertDeepEqual(
    broadcastResult,
    [
      {
        role: "assistant",
        content: [{ type: "input_image", image_url: dataUrl }],
        timestamp: 6,
      },
    ],
    "input_image preserved when redactInlineMedia is disabled",
  );

  const historyProjectionResult = projectRecentChatDisplayMessages(
    [
      {
        role: "assistant",
        content: [{ type: "input_image", image_url: dataUrl }],
        timestamp: 8,
      },
    ],
    { redactInlineMedia: true },
  );
  assertDeepEqual(
    historyProjectionResult,
    [
      {
        role: "assistant",
        content: [
          {
            type: "input_image",
            omitted: true,
            bytes: Buffer.byteLength(dataUrl, "utf8"),
          },
        ],
        timestamp: 8,
      },
    ],
    "projectRecentChatDisplayMessages redacts inline media for history callers",
  );

  const httpsUrl = "https://example.test/photo.png";
  const httpsResult = sanitizeChatHistoryMessages(
    [
      {
        role: "assistant",
        content: [{ type: "image", url: httpsUrl }],
        timestamp: 7,
      },
    ],
    undefined,
    REDACT_OPTS,
  );
  assertDeepEqual(
    httpsResult,
    [
      {
        role: "assistant",
        content: [{ type: "image", url: httpsUrl }],
        timestamp: 7,
      },
    ],
    "https image URL preserved",
  );

  console.log("\nAll proof checks passed.");
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  await main();
}
