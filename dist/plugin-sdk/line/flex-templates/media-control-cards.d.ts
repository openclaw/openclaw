import type { FlexBubble } from "./types.js";
/**
 * Create a media player card for Sonos, Spotify, Apple Music, etc.
 *
 * Editorial design: Album art hero with gradient overlay for text,
 * prominent now-playing indicator, refined playback controls.
 */
export declare function createMediaPlayerCard(params: {
    title: string;
    subtitle?: string;
    source?: string;
    imageUrl?: string;
    isPlaying?: boolean;
    progress?: string;
    controls?: {
        previous?: {
            data: string;
        };
        play?: {
            data: string;
        };
        pause?: {
            data: string;
        };
        next?: {
            data: string;
        };
    };
    extraActions?: Array<{
        label: string;
        data: string;
    }>;
}): FlexBubble;
/**
 * Create an Apple TV remote card with a D-pad and control rows.
 */
export declare function createAppleTvRemoteCard(params: {
    deviceName: string;
    status?: string;
    actionData: {
        up: string;
        down: string;
        left: string;
        right: string;
        select: string;
        menu: string;
        home: string;
        play: string;
        pause: string;
        volumeUp: string;
        volumeDown: string;
        mute: string;
    };
}): FlexBubble;
/**
 * Create a device control card for Apple TV, smart home devices, etc.
 *
 * Editorial design: Device-focused header with status indicator,
 * clean control grid with clear visual hierarchy.
 */
export declare function createDeviceControlCard(params: {
    deviceName: string;
    deviceType?: string;
    status?: string;
    isOnline?: boolean;
    imageUrl?: string;
    controls: Array<{
        label: string;
        icon?: string;
        data: string;
        style?: "primary" | "secondary";
    }>;
}): FlexBubble;
