//#region extensions/byteplus/openclaw.plugin.json
var modelCatalog = {
	"providers": {
		"byteplus": {
			"baseUrl": "https://ark.ap-southeast.bytepluses.com/api/v3",
			"api": "openai-completions",
			"models": [
				{
					"id": "seed-1-8-251228",
					"name": "Seed 1.8",
					"input": ["text", "image"],
					"contextWindow": 256e3,
					"maxTokens": 4096,
					"cost": {
						"input": 1e-4,
						"output": 2e-4,
						"cacheRead": 0,
						"cacheWrite": 0
					}
				},
				{
					"id": "kimi-k2-5-260127",
					"name": "Kimi K2.5",
					"input": ["text", "image"],
					"contextWindow": 256e3,
					"maxTokens": 4096,
					"cost": {
						"input": 1e-4,
						"output": 2e-4,
						"cacheRead": 0,
						"cacheWrite": 0
					}
				},
				{
					"id": "glm-4-7-251222",
					"name": "GLM 4.7",
					"input": ["text", "image"],
					"contextWindow": 2e5,
					"maxTokens": 4096,
					"cost": {
						"input": 1e-4,
						"output": 2e-4,
						"cacheRead": 0,
						"cacheWrite": 0
					}
				}
			]
		},
		"byteplus-plan": {
			"baseUrl": "https://ark.ap-southeast.bytepluses.com/api/coding/v3",
			"api": "openai-completions",
			"models": [
				{
					"id": "ark-code-latest",
					"name": "Ark Coding Plan",
					"input": ["text"],
					"contextWindow": 256e3,
					"maxTokens": 4096,
					"cost": {
						"input": 1e-4,
						"output": 2e-4,
						"cacheRead": 0,
						"cacheWrite": 0
					}
				},
				{
					"id": "doubao-seed-code",
					"name": "Doubao Seed Code",
					"input": ["text"],
					"contextWindow": 256e3,
					"maxTokens": 4096,
					"cost": {
						"input": 1e-4,
						"output": 2e-4,
						"cacheRead": 0,
						"cacheWrite": 0
					}
				},
				{
					"id": "glm-4.7",
					"name": "GLM 4.7 Coding",
					"input": ["text"],
					"contextWindow": 2e5,
					"maxTokens": 4096,
					"cost": {
						"input": 1e-4,
						"output": 2e-4,
						"cacheRead": 0,
						"cacheWrite": 0
					}
				},
				{
					"id": "kimi-k2-thinking",
					"name": "Kimi K2 Thinking",
					"input": ["text"],
					"contextWindow": 256e3,
					"maxTokens": 4096,
					"cost": {
						"input": 1e-4,
						"output": 2e-4,
						"cacheRead": 0,
						"cacheWrite": 0
					}
				},
				{
					"id": "kimi-k2.5",
					"name": "Kimi K2.5 Coding",
					"input": ["text"],
					"contextWindow": 256e3,
					"maxTokens": 4096,
					"cost": {
						"input": 1e-4,
						"output": 2e-4,
						"cacheRead": 0,
						"cacheWrite": 0
					}
				}
			]
		}
	},
	"discovery": {
		"byteplus": "static",
		"byteplus-plan": "static"
	}
};
//#endregion
export { modelCatalog as t };
