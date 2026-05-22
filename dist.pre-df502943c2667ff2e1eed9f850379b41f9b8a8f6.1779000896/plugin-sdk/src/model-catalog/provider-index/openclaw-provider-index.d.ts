export declare const OPENCLAW_PROVIDER_INDEX: {
    version: number;
    providers: {
        moonshot: {
            id: string;
            name: string;
            plugin: {
                id: string;
            };
            docs: string;
            categories: string[];
            previewCatalog: {
                models: {
                    id: string;
                    name: string;
                    input: ("image" | "text")[];
                    contextWindow: number;
                }[];
            };
        };
        deepseek: {
            id: string;
            name: string;
            plugin: {
                id: string;
            };
            docs: string;
            categories: string[];
            previewCatalog: {
                models: ({
                    id: string;
                    name: string;
                    input: "text"[];
                    contextWindow: number;
                    reasoning?: undefined;
                } | {
                    id: string;
                    name: string;
                    input: "text"[];
                    reasoning: true;
                    contextWindow: number;
                })[];
            };
        };
    };
};
