// Type stub for optional @xenova/transformers dependency
declare module "@xenova/transformers" {
  export function pipeline(
    task: string,
    model: string,
    options?: { quantized?: boolean },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped pipeline return
  ): Promise<any>;
  export const env: { allowLocalModels: boolean; useBrowserCache: boolean };
}
