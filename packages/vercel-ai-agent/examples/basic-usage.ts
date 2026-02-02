/**
 * Basic Usage Example for the Vercel AI Agent
 *
 * This example demonstrates how to create and use a conversational agent
 * with tools, callbacks, and streaming.
 */

import { z } from "zod";
import {
	createAgent,
	createToolRegistry,
	calculatorTool,
	dateTimeTool,
	createConversationManager,
	createStreamProcessor,
	type AgentToolDefinition,
	type StepResult,
	type StreamChunk,
	type AgentResponse,
} from "../src/index.js";

// 1. Create a custom tool
const weatherTool: AgentToolDefinition = {
	name: "get_weather",
	description: "Get the current weather for a location",
	parameters: z.object({
		location: z.string().describe("The city and country, e.g., 'London, UK'"),
		units: z
			.enum(["celsius", "fahrenheit"])
			.optional()
			.describe("Temperature units"),
	}),
	async execute({ location, units = "celsius" }) {
		// In a real app, this would call a weather API
		const temp = units === "celsius" ? 22 : 72;
		return {
			location,
			temperature: temp,
			units,
			conditions: "Partly cloudy",
			humidity: 65,
		};
	},
	requiresConfirmation: false,
};

// 2. Create the agent
const agent = createAgent({
	model: {
		provider: "openai",
		modelId: "gpt-4-turbo",
		apiKey: process.env.OPENAI_API_KEY,
	},
	systemPrompt: `You are a helpful assistant with access to various tools.
You can perform calculations, check the current time, and get weather information.
Always be concise and helpful.`,
	tools: [calculatorTool, dateTimeTool, weatherTool],
	defaultExecutionConfig: {
		maxSteps: 5,
		temperature: 0.7,
	},
	defaultCallbacks: {
		onStepStart: (stepNumber) => {
			console.log(`\n--- Starting step ${stepNumber + 1} ---`);
		},
		onStepFinish: (step: StepResult) => {
			console.log(`Step ${step.stepNumber + 1} finished:`);
			console.log(`  Type: ${step.stepType}`);
			console.log(`  Finish reason: ${step.finishReason}`);
			if (step.toolCalls.length > 0) {
				console.log(
					`  Tool calls: ${step.toolCalls.map((tc) => tc.name).join(", ")}`
				);
			}
			console.log(
				`  Tokens: ${step.usage.promptTokens} prompt, ${step.usage.completionTokens} completion`
			);
		},
	},
});

// 3. Basic non-streaming usage
async function basicExample() {
	console.log("=== Basic Non-Streaming Example ===\n");

	const response = await agent.run({
		messages: "What's 42 multiplied by 17, and what's the current time?",
	});

	console.log("\n=== Final Response ===");
	console.log("Text:", response.text);
	console.log("Total steps:", response.steps.length);
	console.log("Total tokens:", response.usage.totalTokens);
	console.log("Finish reason:", response.finishReason);
}

// 4. Streaming usage
async function streamingExample() {
	console.log("\n=== Streaming Example ===\n");

	const stream = await agent.runStream({
		messages: "What's the weather like in Tokyo?",
		executionConfig: {
			stream: true,
		},
		callbacks: {
			onChunk: (chunk: StreamChunk) => {
				if (chunk.type === "text-delta" && chunk.textDelta) {
					process.stdout.write(chunk.textDelta);
				}
			},
		},
	});

	// You can also iterate over the stream manually
	for await (const chunk of stream) {
		// Handle each chunk
		if (chunk.type === "tool-call") {
			console.log(`\n[Tool called: ${chunk.toolCall?.name}]`);
		}
	}

	// Get the final response
	const response = await stream.response;
	console.log("\n\nFinal text:", response.text);
}

// 5. Conversation with history
async function conversationExample() {
	console.log("\n=== Multi-turn Conversation Example ===\n");

	// First message
	console.log("User: What's 100 divided by 4?");
	const response1 = await agent.run({
		messages: "What's 100 divided by 4?",
	});
	console.log("Assistant:", response1.text);

	// Follow-up using conversation history
	console.log("\nUser: Now multiply that by 3");
	const response2 = await agent.run({
		messages: "Now multiply that by 3",
	});
	console.log("Assistant:", response2.text);

	// Check conversation history
	console.log(
		"\nConversation history length:",
		agent.getConversationHistory().length
	);
}

// 6. Using the conversation manager for multiple sessions
async function sessionExample() {
	console.log("\n=== Session Management Example ===\n");

	const manager = createConversationManager({
		maxMessages: 50,
	});

	// Create a session
	const sessionId = manager.createSession({ title: "Math Help" });
	console.log("Created session:", sessionId);

	// Add messages
	manager.addUserMessage(sessionId, "Help me with math");
	manager.addAssistantMessage(sessionId, "Sure! What do you need help with?");
	manager.addUserMessage(sessionId, "What's the square root of 144?");

	// Get messages
	const messages = manager.getMessages(sessionId);
	console.log("Session messages:", messages.length);

	// Update usage
	manager.updateUsage(sessionId, {
		promptTokens: 100,
		completionTokens: 50,
		totalTokens: 150,
	});

	console.log("Session usage:", manager.getUsage(sessionId));
}

// 7. Using the stream processor for advanced streaming
async function advancedStreamingExample() {
	console.log("\n=== Advanced Stream Processing Example ===\n");

	const processor = createStreamProcessor({
		textBufferSize: 20,
		textDebounceMs: 100,
	});

	// Set up event handlers
	processor.on((event) => {
		switch (event.type) {
			case "text":
				console.log(`[Text update] Total: ${event.text.length} chars`);
				break;
			case "tool-call-start":
				console.log(`[Tool starting] ${event.toolCall.name}`);
				break;
			case "tool-call-complete":
				console.log(`[Tool complete] ${event.toolCall.name}`);
				break;
			case "step-complete":
				console.log(`[Step ${event.step.stepNumber + 1} done]`);
				break;
			case "complete":
				console.log(`[Stream complete] Total tokens: ${event.response.usage.totalTokens}`);
				break;
			case "error":
				console.error(`[Error]`, event.error);
				break;
		}
	});

	// Simulate processing chunks (in real usage, these come from the agent stream)
	await processor.processChunk({ type: "text-delta", textDelta: "Hello, " });
	await processor.processChunk({ type: "text-delta", textDelta: "I can help " });
	await processor.processChunk({ type: "text-delta", textDelta: "you with that!" });
	await processor.processChunk({ type: "finish" });

	console.log("\nFinal state:", processor.getState().text);
}

// 8. Human-in-the-loop tool approval
async function approvalExample() {
	console.log("\n=== Human-in-the-Loop Approval Example ===\n");

	// Create an agent with a tool that requires confirmation
	const sensitiveAgent = createAgent({
		model: {
			provider: "openai",
			modelId: "gpt-4-turbo",
			apiKey: process.env.OPENAI_API_KEY,
		},
		tools: [
			{
				name: "delete_file",
				description: "Delete a file from the system",
				parameters: z.object({
					path: z.string().describe("The file path to delete"),
				}),
				execute: async ({ path }) => {
					// Simulated deletion
					return { success: true, deleted: path };
				},
				requiresConfirmation: true, // Requires user approval
			},
		],
	});

	// Run with approval callback
	try {
		const response = await sensitiveAgent.runWithApproval({
			messages: "Please delete the file /tmp/test.txt",
			callbacks: {
				onToolApproval: async (toolCall) => {
					console.log(`\n[Approval required for: ${toolCall.name}]`);
					console.log(`Arguments: ${JSON.stringify(toolCall.arguments)}`);
					// In a real app, you'd prompt the user here
					// For this example, we'll reject the deletion
					console.log(">>> Rejecting the tool execution <<<");
					return false;
				},
			},
		});

		console.log("\nResponse:", response.text);
	} catch (error) {
		console.log("Error:", error);
	}
}

// 9. Custom tool registry
async function registryExample() {
	console.log("\n=== Tool Registry Example ===\n");

	const registry = createToolRegistry();

	// Register individual tools
	registry.register(calculatorTool);
	registry.register(dateTimeTool);
	registry.register(weatherTool);

	// Create tool groups
	registry.createGroup("math", ["calculator"]);
	registry.createGroup("utilities", ["get_current_datetime", "get_weather"]);

	console.log("All tools:", registry.getNames());
	console.log("Math tools:", registry.getGroup("math").map((t) => t.name));
	console.log(
		"Utility tools:",
		registry.getGroup("utilities").map((t) => t.name)
	);

	// Convert to CoreTools format for AI SDK
	const coreTools = registry.toCoreTools();
	console.log("CoreTools count:", Object.keys(coreTools).length);
}

// Run all examples
async function main() {
	try {
		// These examples require an API key
		if (!process.env.OPENAI_API_KEY) {
			console.log("Note: Set OPENAI_API_KEY to run API-dependent examples\n");
		}

		// Run examples that don't require API
		await sessionExample();
		await advancedStreamingExample();
		await registryExample();

		// Run API-dependent examples if key is available
		if (process.env.OPENAI_API_KEY) {
			await basicExample();
			await streamingExample();
			await conversationExample();
			await approvalExample();
		}

		console.log("\n=== All examples completed ===");
	} catch (error) {
		console.error("Example error:", error);
	}
}

main();
