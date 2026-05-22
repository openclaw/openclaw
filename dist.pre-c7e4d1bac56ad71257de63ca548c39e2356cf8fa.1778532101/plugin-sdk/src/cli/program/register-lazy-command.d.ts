import type { Command } from "commander";
type RegisterLazyCommandParams = {
    program: Command;
    name: string;
    description: string;
    options?: readonly {
        flags: string;
        description: string;
    }[];
    removeNames?: string[];
    register: () => Promise<void> | void;
};
export declare function registerLazyCommand({ program, name, description, options, removeNames, register }: RegisterLazyCommandParams): void;
export {};
