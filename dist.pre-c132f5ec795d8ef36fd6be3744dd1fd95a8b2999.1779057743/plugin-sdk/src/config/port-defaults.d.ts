type PortRange = {
    start: number;
    end: number;
};
export declare const DEFAULT_BROWSER_CDP_PORT_RANGE_START = 18800;
export declare const DEFAULT_BROWSER_CDP_PORT_RANGE_END = 18899;
export declare function deriveDefaultBrowserCdpPortRange(browserControlPort: number): PortRange;
export {};
