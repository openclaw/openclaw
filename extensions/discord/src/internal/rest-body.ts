export type RequestData = {
  body?: unknown;
  multipartStyle?: "message" | "form";
  headers?: Record<string, string>;
};

type RequestFile = {
  fieldName?: unknown;
  name?: unknown;
  data?: unknown;
  contentType?: unknown;
  description?: unknown;
  duration_secs?: unknown;
  waveform?: unknown;
};

function fileBlob(file: RequestFile): Blob {
  return file.data instanceof Blob
    ? file.data
    : new Blob([file.data as BlobPart], {
        type: typeof file.contentType === "string" ? file.contentType : undefined,
      });
}

export function serializeRequestBody(
  data: RequestData | undefined,
  headers: Headers,
): BodyInit | undefined {
  if (data?.headers) {
    for (const [key, value] of Object.entries(data.headers)) {
      headers.set(key, value);
    }
  }
  if (data?.body == null) {
    return undefined;
  }
  if (typeof data.body === "object") {
    const bodyObject = data.body as Record<string, unknown>;
    const topLevelFiles = Array.isArray(bodyObject.files) ? bodyObject.files : undefined;
    const nestedData =
      bodyObject.data && typeof bodyObject.data === "object"
        ? (bodyObject.data as Record<string, unknown>)
        : undefined;
    const nestedFiles =
      nestedData && Array.isArray(nestedData.files) ? nestedData.files : undefined;
    const files = topLevelFiles ?? nestedFiles;
    const filesContainer = topLevelFiles ? bodyObject : nestedFiles ? nestedData : undefined;
    if (files?.length && filesContainer) {
      if (data.multipartStyle === "form") {
        const formData = new FormData();
        for (const [key, value] of Object.entries(filesContainer)) {
          if (key === "files" || value === undefined || value === null) {
            continue;
          }
          formData.append(key, typeof value === "string" ? value : JSON.stringify(value));
        }
        for (const file of files) {
          const item = file as RequestFile;
          const name = typeof item.name === "string" && item.name ? item.name : "file";
          formData.append(
            typeof item.fieldName === "string" && item.fieldName ? item.fieldName : "file",
            fileBlob(item),
            name,
          );
        }
        return formData;
      }
      const payloadFilesContainer = { ...filesContainer };
      const payloadJson = topLevelFiles
        ? payloadFilesContainer
        : { ...bodyObject, data: payloadFilesContainer };
      const formData = new FormData();
      const existingAttachments = Array.isArray(payloadFilesContainer.attachments)
        ? [...payloadFilesContainer.attachments]
        : [];
      const uploaded = files.map((file, index) => {
        const item = file as RequestFile;
        const name = typeof item.name === "string" && item.name ? item.name : `file-${index}`;
        const id = existingAttachments.length + index;
        formData.append(`files[${id}]`, fileBlob(item), name);
        const attachment: Record<string, unknown> = {
          id,
          filename: name,
        };
        if (typeof item.description === "string") {
          attachment.description = item.description;
        }
        if (typeof item.duration_secs === "number") {
          attachment.duration_secs = item.duration_secs;
        }
        if (typeof item.waveform === "string") {
          attachment.waveform = item.waveform;
        }
        return attachment;
      });
      payloadFilesContainer.attachments = [...existingAttachments, ...uploaded];
      delete payloadFilesContainer.files;
      formData.append("payload_json", JSON.stringify(payloadJson));
      return formData;
    }
  }
  headers.set("Content-Type", "application/json");
  return JSON.stringify(data.body);
}
