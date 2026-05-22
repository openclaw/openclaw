import { n as createLazyRuntimeMethodBinder, r as createLazyRuntimeModule } from "./lazy-runtime-CUDhYq-w.js";
//#region src/media-understanding/image-runtime.ts
const bindImageRuntime = createLazyRuntimeMethodBinder(createLazyRuntimeModule(() => import("./image-BtBx9xrT.js")));
const describeImageWithModel = bindImageRuntime((runtime) => runtime.describeImageWithModel);
const describeImagesWithModel = bindImageRuntime((runtime) => runtime.describeImagesWithModel);
const describeImageWithModelPayloadTransform = bindImageRuntime((runtime) => runtime.describeImageWithModelPayloadTransform);
const describeImagesWithModelPayloadTransform = bindImageRuntime((runtime) => runtime.describeImagesWithModelPayloadTransform);
//#endregion
export { describeImagesWithModelPayloadTransform as i, describeImageWithModelPayloadTransform as n, describeImagesWithModel as r, describeImageWithModel as t };
