import { Role, User, type StructureClient } from "./structures.js";
type ModalResolvedData = {
    roles?: Record<string, {
        id: string;
        name?: string;
    }>;
    users?: Record<string, {
        id: string;
        username?: string;
        discriminator?: string;
    }>;
};
export declare function extractModalFields(components: unknown[]): Record<string, string | string[]>;
export declare class ModalFields {
    private values;
    private resolved?;
    private client?;
    constructor(values: Record<string, string | string[]>, resolved?: ModalResolvedData | undefined, client?: StructureClient | undefined);
    private value;
    getText(id: string, required?: boolean): string | null;
    getStringSelect(id: string, required?: boolean): string[];
    getRoleSelect(id: string, required?: boolean): Role[];
    getUserSelect(id: string, required?: boolean): User[];
}
export {};
