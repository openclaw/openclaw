declare module "@larksuiteoapi/node-sdk" {
  namespace Lark {
    interface HttpRequestOptions<D = HttpRequestBody> {
      timeout?: number;
    }
  }
}
