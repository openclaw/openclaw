// Tool registry for managing v5 tools

/**
 * Registry for managing agent tools
 *
 * Note: In v5, tools are created using the tool() helper from 'ai' package.
 * This registry provides organizational utilities for managing collections of tools.
 */
export class ToolRegistry {
	private tools: Map<string, any> = new Map();
	private toolGroups: Map<string, Set<string>> = new Map();

	/**
	 * Register a single tool (v5 tool created with tool() helper)
	 */
	register(name: string, tool: any): this {
		if (this.tools.has(name)) {
			throw new Error(`Tool "${name}" is already registered`);
		}
		this.tools.set(name, tool);
		return this;
	}

	/**
	 * Register multiple tools at once
	 */
	registerMany(tools: Record<string, any>): this {
		for (const [name, tool] of Object.entries(tools)) {
			this.register(name, tool);
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
	get(name: string): any | undefined {
		return this.tools.get(name);
	}

	/**
	 * Check if a tool is registered
	 */
	has(name: string): boolean {
		return this.tools.has(name);
	}

	/**
	 * Get all registered tools as a Record
	 */
	getAll(): Record<string, any> {
		return Object.fromEntries(this.tools);
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
	 * Get tools in a group as a Record
	 */
	getGroup(groupName: string): Record<string, any> {
		const group = this.toolGroups.get(groupName);
		if (!group) {
			return {};
		}
		const result: Record<string, any> = {};
		for (const name of group) {
			const tool = this.tools.get(name);
			if (tool) {
				result[name] = tool;
			}
		}
		return result;
	}

	/**
	 * Get tools by names as a Record
	 */
	getByNames(names: string[]): Record<string, any> {
		const result: Record<string, any> = {};
		for (const name of names) {
			const tool = this.tools.get(name);
			if (tool) {
				result[name] = tool;
			}
		}
		return result;
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
		for (const [name, tool] of this.tools) {
			newRegistry.register(name, tool);
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
