import { SaxesParser } from "saxes";

export function parseWebDavFileId(xml: string): string | undefined {
  const parser = new SaxesParser({ xmlns: true });
  const ids: string[] = [];
  let readingFileId = false;
  let fileIdText = "";
  let invalid = false;
  parser.on("opentag", (tag) => {
    if (readingFileId) {
      invalid = true;
    }
    if (tag.uri === "http://owncloud.org/ns" && tag.local === "fileid") {
      readingFileId = true;
      fileIdText = "";
    }
  });
  parser.on("text", (value) => {
    if (readingFileId) {
      fileIdText += value;
    }
  });
  parser.on("closetag", (tag) => {
    if (tag.uri === "http://owncloud.org/ns" && tag.local === "fileid") {
      ids.push(fileIdText.trim());
      readingFileId = false;
    }
  });
  try {
    parser.write(xml).close();
  } catch {
    return undefined;
  }
  const id = ids[0];
  return !invalid && ids.length === 1 && id && /^\d+$/u.test(id) ? id : undefined;
}
