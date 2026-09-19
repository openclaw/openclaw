import { describe, expect, it } from "vitest";
import {
  createFakeClient,
  getSharedCodexAppServerClientMock,
  runCodexAppServerSideQuestion,
  sideParams,
  useSideQuestionTestSetup,
} from "./side-question.test-support.js";

describe("runCodexAppServerSideQuestion images", () => {
  useSideQuestionTestSetup();

  it("runCodexAppServerSideQuestion sends the current image after the question in turn/start", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    const data =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

    await runCodexAppServerSideQuestion(
      sideParams({
        question: " Describe this image. ",
        images: [{ type: "image", data, mimeType: "image/png" }],
      }),
    );

    expect(client.request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({
        input: [
          { type: "text", text: "Describe this image.", text_elements: [] },
          { type: "image", url: `data:image/png;base64,${data}` },
        ],
      }),
      expect.anything(),
    );
  });
});
