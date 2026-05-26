import type { Command } from "commander";
export type NamedCommandDescriptor = {
    name: string;
    description: string;
    hasSubcommands: boolean;
};
export type CommandGroupDescriptorSpec<TRegister> = {
    commandNames: readonly string[];
    register: TRegister;
};
export type ImportedCommandGroupDefinition<TRegisterArgs, TModule> = {
    commandNames: readonly string[];
    loadModule: () => Promise<TModule>;
    register: (module: TModule, args: TRegisterArgs) => Promise<void> | void;
};
export type ResolvedCommandGroupEntry<TDescriptor extends NamedCommandDescriptor, TRegister> = {
    placeholders: TDescriptor[];
    register: TRegister;
};
type CommandGroupEntryLike = {
    placeholders: NamedCommandDescriptor[];
    register: (program: Command) => Promise<void> | void;
};
export declare function resolveCommandGroupEntries<TDescriptor extends NamedCommandDescriptor, TRegister>(descriptors: readonly TDescriptor[], specs: readonly CommandGroupDescriptorSpec<TRegister>[]): ResolvedCommandGroupEntry<TDescriptor, TRegister>[];
export declare function buildCommandGroupEntries<TRegister>(descriptors: readonly NamedCommandDescriptor[], specs: readonly CommandGroupDescriptorSpec<TRegister>[], mapRegister: (register: TRegister) => CommandGroupEntryLike["register"]): CommandGroupEntryLike[];
export declare function defineImportedCommandGroupSpec<TRegisterArgs, TModule>(commandNames: readonly string[], loadModule: () => Promise<TModule>, register: (module: TModule, args: TRegisterArgs) => Promise<void> | void): CommandGroupDescriptorSpec<(args: TRegisterArgs) => Promise<void>>;
export declare function defineImportedCommandGroupSpecs<TRegisterArgs, TModule>(definitions: readonly ImportedCommandGroupDefinition<TRegisterArgs, TModule>[]): CommandGroupDescriptorSpec<(args: TRegisterArgs) => Promise<void>>[];
type ProgramCommandRegistrar = (program: Command) => Promise<void> | void;
type AnyImportedProgramCommandGroupDefinition = {
    commandNames: readonly string[];
    loadModule: () => Promise<Record<string, unknown>>;
    exportName: string;
};
export type ImportedProgramCommandGroupDefinition<TModule extends Record<TKey, ProgramCommandRegistrar>, TKey extends keyof TModule & string> = {
    commandNames: readonly string[];
    loadModule: () => Promise<TModule>;
    exportName: TKey;
};
export declare function defineImportedProgramCommandGroupSpec<TModule extends Record<TKey, ProgramCommandRegistrar>, TKey extends keyof TModule & string>(definition: ImportedProgramCommandGroupDefinition<TModule, TKey>): CommandGroupDescriptorSpec<(program: Command) => Promise<void>>;
export declare function defineImportedProgramCommandGroupSpecs(definitions: readonly AnyImportedProgramCommandGroupDefinition[]): CommandGroupDescriptorSpec<(program: Command) => Promise<void>>[];
export {};
