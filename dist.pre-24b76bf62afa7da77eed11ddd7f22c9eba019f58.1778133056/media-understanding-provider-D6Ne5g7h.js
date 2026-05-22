import { r as describeImagesWithModel, t as describeImageWithModel } from "./image-runtime-DtoI0-KV.js";
import "./media-understanding-pFx6kpQ8.js";
//#region extensions/openrouter/media-understanding-provider.ts
const openrouterMediaUnderstandingProvider = {
	id: "openrouter",
	capabilities: ["image"],
	defaultModels: { image: "auto" },
	describeImage: describeImageWithModel,
	describeImages: describeImagesWithModel
};
//#endregion
export { openrouterMediaUnderstandingProvider as t };
