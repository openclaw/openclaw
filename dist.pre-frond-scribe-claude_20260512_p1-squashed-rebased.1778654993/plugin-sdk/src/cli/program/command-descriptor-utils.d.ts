import type { Command } from "commander";
import type { NamedCommandDescriptor } from "./command-group-descriptors.js";
export type CommandDescriptorLike = Pick<NamedCommandDescriptor, "name" | "description">;
export type CommandDescriptorCatalog<TDescriptor extends NamedCommandDescriptor> = {
    descriptors: readonly TDescriptor[];
    getDescriptors: () => readonly TDescriptor[];
    getNames: () => string[];
    getCommandsWithSubcommands: () => string[];
};
export declare function normalizeCommandDescriptorName(name: string): string | null;
export declare function sanitizeCommandDescriptorDescription(description: string): string;
export declare function getCommandDescriptorNames(descriptors: readonly CommandDescriptorLike[]): string[];
export declare function getCommandsWithSubcommands(descriptors: readonly NamedCommandDescriptor[]): string[];
export declare function collectUniqueCommandDescriptors<TDescriptor extends CommandDescriptorLike>(descriptorGroups: readonly (readonly TDescriptor[])[]): TDescriptor[];
export declare function defineCommandDescriptorCatalog<TDescriptor extends NamedCommandDescriptor>(descriptors: readonly TDescriptor[]): CommandDescriptorCatalog<TDescriptor>;
export declare function addCommandDescriptorsToProgram(program: Command, descriptors: readonly CommandDescriptorLike[], existingCommands?: Set<string>): Set<string>;
