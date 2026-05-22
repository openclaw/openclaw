import { I as APIGuildMember, Tt as APIUser, kt as Snowflake } from "./payload-U2icqU80.js";

//#region node_modules/discord-api-types/payloads/v10/guildScheduledEvent.d.ts
interface APIGuildScheduledEventBase<Type extends GuildScheduledEventEntityType> {
  /**
   * The id of the guild event
   */
  id: Snowflake;
  /**
   * The guild id which the scheduled event belongs to
   */
  guild_id: Snowflake;
  /**
   * The channel id in which the scheduled event will be hosted, or `null` if entity type is `EXTERNAL`
   */
  channel_id: Snowflake | null;
  /**
   * The id of the user that created the scheduled event
   */
  creator_id?: Snowflake | null;
  /**
   * The name of the scheduled event
   */
  name: string;
  /**
   * The description of the scheduled event
   */
  description?: string | null;
  /**
   * The time the scheduled event will start
   */
  scheduled_start_time: string;
  /**
   * The time at which the guild event will end, or `null` if the event does not have a scheduled time to end
   */
  scheduled_end_time: string | null;
  /**
   * The privacy level of the scheduled event
   */
  privacy_level: GuildScheduledEventPrivacyLevel;
  /**
   * The status of the scheduled event
   */
  status: GuildScheduledEventStatus;
  /**
   * The type of hosting entity associated with the scheduled event
   */
  entity_type: Type;
  /**
   * The id of the hosting entity associated with the scheduled event
   */
  entity_id: Snowflake | null;
  /**
   * The entity metadata for the scheduled event
   */
  entity_metadata: APIGuildScheduledEventEntityMetadata | null;
  /**
   * The user that created the scheduled event
   */
  creator?: APIUser;
  /**
   * The number of users subscribed to the scheduled event
   */
  user_count?: number;
  /**
   * The cover image of the scheduled event
   */
  image?: string | null;
  /**
   * The definition for how often this event should recur
   */
  recurrence_rule: APIGuildScheduledEventRecurrenceRule | null;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild-scheduled-event#guild-scheduled-event-recurrence-rule-object-guild-scheduled-event-recurrence-rule-structure}
 */
interface APIGuildScheduledEventRecurrenceRule {
  /**
   * Starting time of the recurrence interval
   */
  start: string;
  /**
   * Ending time of the recurrence interval
   */
  end: string | null;
  /**
   * How often the event occurs
   */
  frequency: GuildScheduledEventRecurrenceRuleFrequency;
  /**
   * The spacing between the events, defined by `frequency`.
   * For example, `frequency` of {@link GuildScheduledEventRecurrenceRuleFrequency.Weekly} and an `interval` of `2`
   * would be "every-other week"
   */
  interval: number;
  /**
   * Set of specific days within a week for the event to recur on
   */
  by_weekday: GuildScheduledEventRecurrenceRuleWeekday[] | null;
  /**
   * List of specific days within a specific week (1-5) to recur on
   */
  by_n_weekday: APIGuildScheduledEventRecurrenceRuleNWeekday[] | null;
  /**
   * Set of specific months to recur on
   */
  by_month: GuildScheduledEventRecurrenceRuleMonth[] | null;
  /**
   * Set of specific dates within a month to recur on
   */
  by_month_day: number[] | null;
  /**
   * Set of days within a year to recur on (1-364)
   */
  by_year_day: number[] | null;
  /**
   * The total amount of times that the event is allowed to recur before stopping
   */
  count: number | null;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild-scheduled-event#guild-scheduled-event-recurrence-rule-object-guild-scheduled-event-recurrence-rule-frequency}
 */
declare enum GuildScheduledEventRecurrenceRuleFrequency {
  Yearly = 0,
  Monthly = 1,
  Weekly = 2,
  Daily = 3
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild-scheduled-event#guild-scheduled-event-recurrence-rule-object-guild-scheduled-event-recurrence-rule-weekday}
 */
declare enum GuildScheduledEventRecurrenceRuleWeekday {
  Monday = 0,
  Tuesday = 1,
  Wednesday = 2,
  Thursday = 3,
  Friday = 4,
  Saturday = 5,
  Sunday = 6
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild-scheduled-event#guild-scheduled-event-recurrence-rule-object-guild-scheduled-event-recurrence-rule-month}
 */
declare enum GuildScheduledEventRecurrenceRuleMonth {
  January = 1,
  February = 2,
  March = 3,
  April = 4,
  May = 5,
  June = 6,
  July = 7,
  August = 8,
  September = 9,
  October = 10,
  November = 11,
  December = 12
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild-scheduled-event#guild-scheduled-event-recurrence-rule-object-guild-scheduled-event-recurrence-rule-nweekday-structure}
 */
interface APIGuildScheduledEventRecurrenceRuleNWeekday {
  /**
   * The week to reoccur on.
   */
  n: 1 | 2 | 3 | 4 | 5;
  /**
   * The day within the week to reoccur on
   */
  day: GuildScheduledEventRecurrenceRuleWeekday;
}
interface APIStageInstanceGuildScheduledEvent extends APIGuildScheduledEventBase<GuildScheduledEventEntityType.StageInstance> {
  channel_id: Snowflake;
  entity_metadata: null;
}
interface APIVoiceGuildScheduledEvent extends APIGuildScheduledEventBase<GuildScheduledEventEntityType.Voice> {
  channel_id: Snowflake;
  entity_metadata: null;
}
interface APIExternalGuildScheduledEvent extends APIGuildScheduledEventBase<GuildScheduledEventEntityType.External> {
  channel_id: null;
  entity_metadata: Required<APIGuildScheduledEventEntityMetadata>;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild-scheduled-event#guild-scheduled-event-object-guild-scheduled-event-structure}
 */
type APIGuildScheduledEvent = APIExternalGuildScheduledEvent | APIStageInstanceGuildScheduledEvent | APIVoiceGuildScheduledEvent;
/**
 * @see {@link https://discord.com/developers/docs/resources/guild-scheduled-event#guild-scheduled-event-object-guild-scheduled-event-entity-metadata}
 */
interface APIGuildScheduledEventEntityMetadata {
  /**
   * The location of the scheduled event
   */
  location?: string;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild-scheduled-event#guild-scheduled-event-object-guild-scheduled-event-entity-types}
 */
declare enum GuildScheduledEventEntityType {
  StageInstance = 1,
  Voice = 2,
  External = 3
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild-scheduled-event#guild-scheduled-event-object-guild-scheduled-event-status}
 */
declare enum GuildScheduledEventStatus {
  Scheduled = 1,
  Active = 2,
  Completed = 3,
  Canceled = 4
}
/**
 * @see {@link https://discord.com/developers/docs/resources/guild-scheduled-event#guild-scheduled-event-object-guild-scheduled-event-privacy-level}
 */
declare enum GuildScheduledEventPrivacyLevel {
  /**
   * The scheduled event is only accessible to guild members
   */
  GuildOnly = 2
}
//#endregion
//#region node_modules/discord-api-types/payloads/v10/voice.d.ts
/**
 * @see {@link https://discord.com/developers/docs/resources/voice#voice-state-object}
 */
interface APIBaseVoiceState {
  /**
   * The channel id this user is connected to
   */
  channel_id: Snowflake | null;
  /**
   * The user id this voice state is for
   */
  user_id: Snowflake;
  /**
   * The guild member this voice state is for
   *
   * @remarks The member field will have `joined_at` set to `null` if the member was invited as a guest.
   * @see {@link https://discord.com/developers/docs/resources/guild#guild-member-object}
   */
  member?: APIGuildMember;
  /**
   * The session id for this voice state
   */
  session_id: string;
  /**
   * Whether this user is deafened by the server
   */
  deaf: boolean;
  /**
   * Whether this user is muted by the server
   */
  mute: boolean;
  /**
   * Whether this user is locally deafened
   */
  self_deaf: boolean;
  /**
   * Whether this user is locally muted
   */
  self_mute: boolean;
  /**
   * Whether this user is streaming using "Go Live"
   */
  self_stream?: boolean;
  /**
   * Whether this user's camera is enabled
   */
  self_video: boolean;
  /**
   * Whether this user is muted by the current user
   */
  suppress: boolean;
  /**
   * The time at which the user requested to speak
   */
  request_to_speak_timestamp: string | null;
}
/**
 * @see {@link https://discord.com/developers/docs/resources/voice#voice-state-object}
 */
interface APIVoiceState extends APIBaseVoiceState {
  /**
   * The guild id this voice state is for
   */
  guild_id?: Snowflake;
}
//#endregion
export { APIGuildScheduledEventRecurrenceRule as a, GuildScheduledEventStatus as c, APIGuildScheduledEventEntityMetadata as i, APIVoiceState as n, GuildScheduledEventEntityType as o, APIGuildScheduledEvent as r, GuildScheduledEventPrivacyLevel as s, APIBaseVoiceState as t };