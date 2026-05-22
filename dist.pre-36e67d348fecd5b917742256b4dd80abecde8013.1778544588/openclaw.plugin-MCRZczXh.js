//#region extensions/mistral/openclaw.plugin.json
var modelCatalog = {
	"providers": { "mistral": {
		"baseUrl": "https://api.mistral.ai/v1",
		"api": "openai-completions",
		"models": [
			{
				"id": "codestral-latest",
				"name": "Codestral (latest)",
				"input": ["text"],
				"contextWindow": 256e3,
				"maxTokens": 4096,
				"cost": {
					"input": .3,
					"output": .9,
					"cacheRead": 0,
					"cacheWrite": 0
				}
			},
			{
				"id": "devstral-medium-latest",
				"name": "Devstral 2 (latest)",
				"input": ["text"],
				"contextWindow": 262144,
				"maxTokens": 32768,
				"cost": {
					"input": .4,
					"output": 2,
					"cacheRead": 0,
					"cacheWrite": 0
				}
			},
			{
				"id": "magistral-small",
				"name": "Magistral Small",
				"input": ["text"],
				"reasoning": true,
				"contextWindow": 128e3,
				"maxTokens": 4e4,
				"cost": {
					"input": .5,
					"output": 1.5,
					"cacheRead": 0,
					"cacheWrite": 0
				}
			},
			{
				"id": "mistral-large-latest",
				"name": "Mistral Large (latest)",
				"input": ["text", "image"],
				"contextWindow": 262144,
				"maxTokens": 16384,
				"cost": {
					"input": .5,
					"output": 1.5,
					"cacheRead": 0,
					"cacheWrite": 0
				}
			},
			{
				"id": "mistral-medium-2508",
				"name": "Mistral Medium 3.1",
				"input": ["text", "image"],
				"contextWindow": 262144,
				"maxTokens": 8192,
				"cost": {
					"input": .4,
					"output": 2,
					"cacheRead": 0,
					"cacheWrite": 0
				}
			},
			{
				"id": "mistral-small-latest",
				"name": "Mistral Small (latest)",
				"input": ["text", "image"],
				"reasoning": true,
				"contextWindow": 128e3,
				"maxTokens": 16384,
				"cost": {
					"input": .1,
					"output": .3,
					"cacheRead": 0,
					"cacheWrite": 0
				}
			},
			{
				"id": "pixtral-large-latest",
				"name": "Pixtral Large (latest)",
				"input": ["text", "image"],
				"contextWindow": 128e3,
				"maxTokens": 32768,
				"cost": {
					"input": 2,
					"output": 6,
					"cacheRead": 0,
					"cacheWrite": 0
				}
			}
		]
	} },
	"discovery": { "mistral": "static" }
};
//#endregion
export { modelCatalog as t };
