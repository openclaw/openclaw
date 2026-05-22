import { r as describeImagesWithModel, t as describeImageWithModel } from "./image-runtime-BHot8e36.js";
import "./media-understanding-BEJpC1Sr.js";
//#region extensions/zai/media-understanding-provider.ts
const zaiMediaUnderstandingProvider = {
	id: "zai",
	capabilities: ["image"],
	defaultModels: { image: "glm-4.6v" },
	autoPriority: { image: 60 },
	describeImage: describeImageWithModel,
	describeImages: describeImagesWithModel
};
//#endregion
export { zaiMediaUnderstandingProvider as t };
