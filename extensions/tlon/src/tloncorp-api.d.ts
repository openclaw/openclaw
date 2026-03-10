declare module "@tloncorp/api" {
  export type ConfigureClientParams = {
    shipUrl: string;
    shipName: string;
    verbose?: boolean;
    getCode: (() => Promise<string>) | (() => string);
  };

  export function configureClient(params: ConfigureClientParams): void;

  export type UploadFileParams = {
    blob: Blob;
    fileName: string;
    contentType: string;
  };

  export function uploadFile(params: UploadFileParams): Promise<{ url: string }>;
}
