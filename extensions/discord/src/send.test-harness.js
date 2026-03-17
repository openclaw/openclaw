import { vi } from "vitest";
function discordWebMediaMockFactory() {
  return {
    loadWebMedia: vi.fn().mockResolvedValue({
      buffer: Buffer.from("img"),
      fileName: "photo.jpg",
      contentType: "image/jpeg",
      kind: "image"
    }),
    loadWebMediaRaw: vi.fn().mockResolvedValue({
      buffer: Buffer.from("img"),
      fileName: "asset.png",
      contentType: "image/png",
      kind: "image"
    })
  };
}
function makeDiscordRest() {
  const postMock = vi.fn();
  const putMock = vi.fn();
  const getMock = vi.fn();
  const patchMock = vi.fn();
  const deleteMock = vi.fn();
  return {
    rest: {
      post: postMock,
      put: putMock,
      get: getMock,
      patch: patchMock,
      delete: deleteMock
    },
    postMock,
    putMock,
    getMock,
    patchMock,
    deleteMock
  };
}
export {
  discordWebMediaMockFactory,
  makeDiscordRest
};
