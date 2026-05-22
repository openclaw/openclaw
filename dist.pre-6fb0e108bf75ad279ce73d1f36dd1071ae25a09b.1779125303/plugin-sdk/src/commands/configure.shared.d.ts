import { confirm as clackConfirm, select as clackSelect, text as clackText } from "@clack/prompts";
export declare const CONFIGURE_WIZARD_SECTIONS: readonly ["workspace", "model", "web", "gateway", "daemon", "channels", "plugins", "skills", "health"];
export type WizardSection = (typeof CONFIGURE_WIZARD_SECTIONS)[number];
export declare function parseConfigureWizardSections(raw: unknown): {
    sections: WizardSection[];
    invalid: string[];
};
export type ChannelsWizardMode = "configure" | "remove";
export type ConfigureWizardParams = {
    command: "configure" | "update";
    sections?: WizardSection[];
};
export declare const CONFIGURE_SECTION_OPTIONS: Array<{
    value: WizardSection;
    label: string;
    hint: string;
}>;
export declare const intro: (message: string) => void;
export declare const outro: (message: string) => void;
export declare const text: (params: Parameters<typeof clackText>[0]) => Promise<string | symbol>;
export declare const confirm: (params: Parameters<typeof clackConfirm>[0]) => Promise<symbol | boolean>;
export declare const select: <T>(params: Parameters<typeof clackSelect<T>>[0]) => Promise<symbol | T>;
