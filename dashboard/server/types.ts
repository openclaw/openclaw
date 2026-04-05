export type LightState = {
  id: number;
  name: string;
  on: boolean;
  level: number; // 0–100
};

export type ThermostatState = {
  id: number;
  name: string;
  tempF: number | null;
  heatSetpointF: number | null;
  coolSetpointF: number | null;
  hvacMode: string | null;
};

export type AudioSource = {
  id: number;
  name: string;
};

export type AudioZoneState = {
  roomId: number;
  sources: AudioSource[];
  currentVolume: number | null;
  currentSourceId: number | null;
};

export type LockState = {
  id: number;
  name: string;
  locked: boolean | null; // null = unknown
};

export type RoomState = {
  id: number;
  name: string;
  lights: LightState[];
  thermostats: ThermostatState[];
  audio: AudioZoneState | null;
  locks: LockState[];
};

export type HomeState = {
  rooms: RoomState[];
  fetchedAt: number;
};
