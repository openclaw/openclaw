import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { createSlackCanvas, createSlackConversationCanvas, editSlackCanvas } from "./actions.js";

function createClient() {
  return {
    apiCall: vi.fn(async () => ({ ok: true })),
  } as unknown as WebClient & {
    apiCall: ReturnType<typeof vi.fn>;
  };
}

describe("Slack canvas actions", () => {
  it("wraps canvas create markdown as Slack document content", async () => {
    const client = createClient();

    await createSlackCanvas({
      client,
      title: "Incident notes",
      documentContent: "# Notes",
    });

    expect(client.apiCall).toHaveBeenCalledWith("canvases.create", {
      title: "Incident notes",
      document_content: {
        type: "markdown",
        markdown: "# Notes",
      },
    });
  });

  it("wraps conversation canvas create markdown as Slack document content", async () => {
    const client = createClient();

    await createSlackConversationCanvas("C123", {
      client,
      title: "Runbook",
      documentContent: "Steps",
    });

    expect(client.apiCall).toHaveBeenCalledWith("conversations.canvases.create", {
      channel_id: "C123",
      title: "Runbook",
      document_content: {
        type: "markdown",
        markdown: "Steps",
      },
    });
  });

  it("forwards Slack canvas edit changes arrays", async () => {
    const client = createClient();
    const changes = [
      {
        operation: "insert_at_end",
        document_content: { type: "markdown", markdown: "Next" },
      },
    ];

    await editSlackCanvas("CAN1", changes, { client });

    expect(client.apiCall).toHaveBeenCalledWith("canvases.edit", {
      canvas_id: "CAN1",
      changes,
    });
  });
});
