declare module "@tloncorp/api" {
  export function configureClient(params: {
    shipUrl: string;
    shipName: string;
    verbose?: boolean;
    getCode?: () => Promise<string> | string;
  }): Promise<void>;

  export function uploadFile(params: {
    blob: Blob;
    fileName?: string;
    contentType?: string;
  }): Promise<{ url: string }>;
}
