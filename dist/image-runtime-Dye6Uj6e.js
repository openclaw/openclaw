import { n as createLazyRuntimeMethodBinder, r as createLazyRuntimeModule } from "./lazy-runtime-D-7_JraP.js";
//#region src/media-understanding/image-runtime.ts
const bindImageRuntime = createLazyRuntimeMethodBinder(createLazyRuntimeModule(() => import("./image-aaTGWTQz.js")));
const describeImageWithModel = bindImageRuntime((runtime) => runtime.describeImageWithModel);
const describeImagesWithModel = bindImageRuntime((runtime) => runtime.describeImagesWithModel);
const describeImageWithModelPayloadTransform = bindImageRuntime((runtime) => runtime.describeImageWithModelPayloadTransform);
const describeImagesWithModelPayloadTransform = bindImageRuntime((runtime) => runtime.describeImagesWithModelPayloadTransform);
//#endregion
export { describeImagesWithModelPayloadTransform as i, describeImageWithModelPayloadTransform as n, describeImagesWithModel as r, describeImageWithModel as t };
