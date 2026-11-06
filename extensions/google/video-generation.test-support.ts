import type { Video } from "@google/genai";

export function completedVideo(
  video: Video = {
    uri: "https://generativelanguage.googleapis.com/v1beta/files/generated-video:download?alt=media",
    mimeType: "video/mp4",
  },
  fields: { name?: string } = {},
) {
  return { done: true, ...fields, response: { generatedVideos: [{ video }] } };
}

export function completedRestVideoResponse() {
  return new Response(
    JSON.stringify({
      done: true,
      name: "operations/rest-123",
      response: {
        generateVideoResponse: {
          generatedSamples: [
            {
              video: {
                uri: "https://generativelanguage.googleapis.com/v1beta/files/rest-video:download?alt=media",
                mimeType: "video/mp4",
              },
            },
          ],
        },
      },
    }),
  );
}

export function videoDownloadResponse(body: string, contentType = "video/mp4") {
  return new Response(body, {
    status: 200,
    statusText: "OK",
    headers: { "content-type": contentType },
  });
}
