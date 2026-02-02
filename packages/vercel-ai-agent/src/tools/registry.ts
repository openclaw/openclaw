import type { CoreTool } from "ai";
import type { AgentToolDefinition, ToolParameters } from "../types.js";
import { toCoreTool } from "../types.js";

/**
 * Registry for managing agent tools
 */
export class ToolRegistry {
	private tools: Map<string, AgentToolDefinition> = new Map();
	private toolGroups: Map<string, Set<string>> = new Map();

	/**
	 * Register a single tool
	 */
	register<T extends ToolParameters>(tool: AgentToolDefinition<T>): this {
		if (this.tools.has(tool.name)) {
			throw new Error(`Tool "${tool.name}" is already registered`);
		}
		this.tools.set(tool.name, tool as AgentToolDefinition);
		return this;
	}

	/**
	 * Register multiple tools at once
	 */
	registerMany(tools: AgentToolDefinition[]): this {
		for (const tool of tools) {
			this.register(tool);
		}
		return this;
	}

	/**
	 * Unregister a tool by name
	 */
	unregister(name: string): boolean {
		// Also remove from any groups
		for (const group of this.toolGroups.values()) {
			group.delete(name);
		}
		return this.tools.delete(name);
	}

	/**
	 * Get a tool by name
	 */
	get(name: string): AgentToolDefinition | undefined {
		return this.tools.get(name);
	}

	/**
	 * Check if a tool is registered
	 */
	has(name: string): boolean {
		return this.tools.has(name);
	}

	/**
	 * Get all registered tools
	 */
	getAll(): AgentToolDefinition[] {
		return Array.from(this.tools.values());
	}

	/**
	 * Get all tool names
	 */
	getNames(): string[] {
		return Array.from(this.tools.keys());
	}

	/**
	 * Create a tool group for organizing tools
	 */
	createGroup(groupName: string, toolNames: string[]): this {
		const group = new Set<string>();
		for (const name of toolNames) {
			if (!this.tools.has(name)) {
				throw new Error(`Tool "${name}" is not registered`);
			}
			group.add(name);
		}
		this.toolGroups.set(groupName, group);
		return this;
	}

	/**
	 * Add a tool to an existing group
	 */
	addToGroup(groupName: string, toolName: string): this {
		if (!this.tools.has(toolName)) {
			throw new Error(`Tool "${toolName}" is not registered`);
		}
		let group = this.toolGroups.get(groupName);
		if (!group) {
			group = new Set();
			this.toolGroups.set(groupName, group);
		}
		group.add(toolName);
		return this;
	}

	/**
	 * Get tools in a group
	 */
	getGroup(groupName: string): AgentToolDefinition[] {
		const group = this.toolGroups.get(groupName);
		if (!group) {
			return [];
		}
		return Array.from(group)
			.map((name) => this.tools.get(name))
			.filter((t): t is AgentToolDefinition => t !== undefined);
	}

	/**
	 * Get tools by names
	 */
	getByNames(names: string[]): AgentToolDefinition[] {
		return names
			.map((name) => this.tools.get(name))
			.filter((t): t is AgentToolDefinition => t !== undefined);
	}

	/**
	 * Convert all tools to AI SDK CoreTool format
	 */
	toCoreTools(): Record<string, CoreTool> {
		const result: Record<string, CoreTool> = {};
		for (const [name, tool] of this.tools) {
			result[name] = toCoreTool(tool);
		}
		return result;
	}

	/**
	 * Convert specific tools to AI SDK CoreTool format
	 */
	toCoreToolsFiltered(names: string[]): Record<string, CoreTool> {
		const result: Record<string, CoreTool> = {};
		for (const name of names) {
			const tool = this.tools.get(name);
			if (tool) {
				result[name] = toCoreTool(tool);
			}
		}
		return result;
	}

	/**
	 * Convert a group to AI SDK CoreTool format
	 */
	groupToCoreTools(groupName: string): Record<string, CoreTool> {
		const group = this.toolGroups.get(groupName);
		if (!group) {
			return {};
		}
		return this.toCoreToolsFiltered(Array.from(group));
	}

	/**
	 * Get the count of registered tools
	 */
	get size(): number {
		return this.tools.size;
	}

	/**
	 * Clear all registered tools
	 */
	clear(): void {
		this.tools.clear();
		this.toolGroups.clear();
	}

	/**
	 * Clone the registry
	 */
	clone(): ToolRegistry {
		const newRegistry = new ToolRegistry();
		for (const tool of this.tools.values()) {
			newRegistry.register(tool);
		}
		for (const [groupName, group] of this.toolGroups) {
			newRegistry.createGroup(groupName, Array.from(group));
		}
		return newRegistry;
	}
}

/**
 * Create a new tool registry
 */
export function createToolRegistry(): ToolRegistry {
	return new ToolRegistry();
}

/**
 * Global default registry instance
 */
export const defaultRegistry = new ToolRegistry();
