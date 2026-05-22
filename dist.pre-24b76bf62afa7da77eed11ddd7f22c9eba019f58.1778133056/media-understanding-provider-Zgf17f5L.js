import { r as describeImagesWithModel, t as describeImageWithModel } from "./image-runtime-DtoI0-KV.js";
import "./media-understanding-pFx6kpQ8.js";
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
