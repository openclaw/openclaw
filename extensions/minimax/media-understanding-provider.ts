import {
	describeImagesWithModel,
	describeImageWithModel,
	type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";

export const minimaxMediaUnderstandingProvider: MediaUnderstandingProvider = {
	id: "minimax",
	capabilities: ["image"],
	describeImage: describeImageWithModel,
	describeImages: describeImagesWithModel,
};

export const minimaxPortalMediaUnderstandingProvider: MediaUnderstandingProvider =
	{
		id: "minimax-portal",
		capabilities: ["image"],
		describeImage: describeImageWithModel,
		describeImages: describeImagesWithModel,
	};
