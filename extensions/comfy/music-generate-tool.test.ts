import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import { createComfyMusicGenerateTool } from "./music-generate-tool.js";
import { _setComfyFetchGuardForTesting } from "./workflow-runtime.js";

const { fetchWithSsrFGuardMock, saveMediaBufferMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  saveMediaBufferMock: vi.fn(async () => ({
    path: "/tmp/generated-song.mp3",
    id: "music-1",
    mimeType: "audio/mpeg",
    bytes: 12,
  })),
}));

describe("comfy music_generate tool", () => {
  it("lists the comfy workflow model", async () => {
    const tool = createComfyMusicGenerateTool(createTestPluginApi());
    const result = await tool.execute("tool-1", { action: "list" });
    expect((result.content[0] as { text: string }).text).toContain("comfy/workflow");
  });

  it("runs a music workflow and saves audio outputs", async () => {
    _setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ prompt_id: "music-job-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            "music-job-1": {
              outputs: {
                "9": {
                  audio: [{ filename: "song.mp3", subfolder: "", type: "output" }],
                },
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("music-bytes"), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
        release: vi.fn(async () => {}),
      });

    const api = createTestPluginApi({
      config: {
        models: {
          providers: {
            comfy: {
              music: {
                workflow: {
                  "6": { inputs: { text: "" } },
                  "9": { inputs: {} },
                },
                promptNodeId: "6",
                outputNodeId: "9",
              },
            },
          },
        },
      } as never,
      runtime: {
        channel: {
          media: {
            saveMediaBuffer: saveMediaBufferMock,
          },
        },
      } as never,
    });

    const tool = createComfyMusicGenerateTool(api);
    const result = await tool.execute("tool-2", {
      prompt: "gentle ambient synth loop",
    });

    expect(saveMediaBufferMock).toHaveBeenCalledWith(
      Buffer.from("music-bytes"),
      "audio/mpeg",
      "tool-music-generation",
      undefined,
      "song.mp3",
    );
    expect((result.content[0] as { text: string }).text).toContain("MEDIA:/tmp/generated-song.mp3");
    expect(result.details).toMatchObject({
      provider: "comfy",
      model: "workflow",
      count: 1,
      paths: ["/tmp/generated-song.mp3"],
      media: {
        mediaUrls: ["/tmp/generated-song.mp3"],
      },
    });
  });
});
