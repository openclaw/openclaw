type ConfigureClientParams = {
  shipUrl: string;
  shipName: string;
  verbose?: boolean;
  getCode?: () => Promise<string> | string;
};

type UploadFileParams = {
  blob: Blob;
  fileName?: string;
  contentType?: string;
};

type UploadFileResult = {
  url: string;
};

type TlonApiModule = {
  configureClient: (params: ConfigureClientParams) => Promise<void>;
  uploadFile: (params: UploadFileParams) => Promise<UploadFileResult>;
};

export async function loadTlonApi(): Promise<TlonApiModule> {
  return (await import("@tloncorp/api")) as unknown as TlonApiModule;
}
