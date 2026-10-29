// Slack web-client hooks verified 2026-09-26. Text and aria fallbacks assume English.
export const SLACK_HUDDLE_SELECTORS = {
  preview: ['[data-qa="huddle_join_preview_modal"]'],
  join: ['[data-qa="huddle_join_preview_modal_go"]'],
  confirmation: ['[data-qa="huddle_join_modal"]', '[data-qa="huddle_in_thread_speed_bump_modal"]'],
  multiDevice: [
    '[data-qa="huddle_multi_device_modal_switch_device"]',
    '[data-qa="huddle_multi_device_modal_use_both_device"]',
  ],
  previewMicrophone: ['[data-qa="huddle_join_preview_mic_button"]'],
  microphone: [
    'button[role="switch"][aria-label="Microphone"]',
    '[data-qa="huddle_sidebar_footer_mute_button"]',
    '[data-qa="segmented-mute-button-main"]',
    'button[aria-describedby="microphone-info"]',
  ],
  mutedIcon: ['[data-qa="huddle_mic_icon_mute"]'],
  unmutedIcon: ['[data-qa="huddle_mic_icon_unmute"]'],
  leave: [
    '[data-qa="huddle_toolbar__leave_button"]',
    '[data-qa="huddle_mini_player_leave_button"]',
  ],
  inCall: [
    '[data-qa="huddle_toolbar__leave_button"]',
    '[data-qa="huddle_mini_player_leave_button"]',
    '[data-qa="huddle_sidebar_footer"]',
    '[data-qa="huddle_toolbar_buttons_center"]',
  ],
  // Slack sets this class only while this device is in the viewed channel's huddle.
  channelHeader: [".p-huddle_channel_header_button__container"],
  channelHeaderInHuddle: [".p-huddle_channel_header_button--in_huddle"],
  huddleSurfaces: [
    '[data-qa="huddle_join_preview_modal"]',
    '[role="dialog"]',
    '[data-qa="huddle_sidebar_footer"]',
    '[data-qa="huddle_toolbar_buttons_center"]',
    '[data-qa="huddle_mini_player"]',
  ],
  signIn: ['form[action*="signin"]', 'input[name="email"]', 'input[type="password"]'],
  title: ['[data-qa="huddle_window_titlebar_title"]', '[data-qa="huddle_details_title"]'],
  participants: [
    '[data-qa^="huddle_peer_tile_userId_"]',
    '[data-qa="huddle_avatar_stack__member"]',
  ],
  deviceSettings: ['[data-qa="huddle-toolbar-mic-popover-button"]'],
  audioDeviceOptions: ['[data-qa^="av-microphone-device-menu-item_"]'],
  // Slack renders its selected/preferred microphone label here, not the available-device list.
  microphoneDevice: ["#microphone-info"],
  microphoneDeviceMenu: [],
  microphoneDeviceScope: '[role="dialog"]',
  selectedMicrophoneDevice: ["option:checked", '[role="option"][aria-selected="true"]'],
  captionsOff: [],
  captionRenderer: [
    ".p-huddle_closed_captions",
    ".p-huddle_closed_caption_event__event_text",
    '[data-qa="huddle_transcribe_event"]',
  ],
  captionContent: ["body"],
  captionRows: [
    '.p-huddle_closed_caption_event__wrapper, :has(> .p-huddle_closed_caption_event__member_name):has(> .p-huddle_closed_caption_event__event_text), [data-qa="huddle_transcribe_event"]',
  ],
  captionAuthor: [".p-huddle_closed_caption_event__member_name"],
  captionText: [
    '.p-huddle_closed_caption_event__event_text span[data-qa="huddle_closed_caption_event"]',
    '[data-qa="huddle_transcribe_event"]',
  ],
} as const;
