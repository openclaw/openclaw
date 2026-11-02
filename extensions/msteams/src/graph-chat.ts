import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { buildFileInfoCard } from "./file-consent.js";
import type { DriveItemProperties } from "./graph-upload.js";

export function buildTeamsFileInfoCard(file: DriveItemProperties) {
  // SharePoint eTags wrap the driveItem GUID in quotes/braces and append a version.
  const rawETag = file.eTag;
  const uniqueId =
    rawETag
      .replace(/^["']|["']$/g, "")
      .replace(/[{}]/g, "")
      .split(",")[0] ?? rawETag;

  const lastDot = file.name.lastIndexOf(".");
  const fileType =
    lastDot >= 0 ? normalizeLowercaseStringOrEmpty(file.name.slice(lastDot + 1)) : "";

  return buildFileInfoCard({
    filename: file.name,
    contentUrl: file.webDavUrl,
    uniqueId,
    fileType,
  });
}
