/** Stored OAuth tokens for a connected Strava athlete. */
export interface StravaTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix epoch (seconds) when accessToken expires. */
  expiresAt: number;
  /** String to avoid JS number precision loss on 64-bit Strava IDs. */
  athleteId: string;
}

/** Plugin config provided by the deployer. */
export interface StravaConfig {
  clientId: string;
  clientSecret: string;
}

/** Summary activity returned by GET /athlete/activities. */
export interface StravaActivity {
  /** String to avoid JS number precision loss on 64-bit Strava IDs. */
  id: string;
  name: string;
  sport_type: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  total_elevation_gain: number;
  average_speed: number;
  max_speed: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_cadence?: number;
  start_date: string;
  start_date_local: string;
  timezone: string;
  kudos_count: number;
  suffer_score?: number;
}

/** Lap data within a detailed activity. */
export interface StravaLap {
  name: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  average_speed: number;
  max_speed: number;
  average_heartrate?: number;
  max_heartrate?: number;
  lap_index: number;
}

/** Split data (per km or per mile). */
export interface StravaSplit {
  distance: number;
  moving_time: number;
  elapsed_time: number;
  average_speed: number;
  average_heartrate?: number;
  split: number;
}

/** Full activity detail from GET /activities/{id}. */
export interface StravaActivityDetail extends StravaActivity {
  description?: string;
  calories: number;
  laps: StravaLap[];
  splits_metric: StravaSplit[];
  gear?: { id: string; name: string };
  device_name?: string;
}

/** Totals for a sport type (run, ride, swim). */
export interface StravaSportTotals {
  count: number;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  elevation_gain: number;
}

/** Aggregated athlete stats from GET /athletes/{id}/stats. */
export interface StravaAthleteStats {
  recent_run_totals: StravaSportTotals;
  recent_ride_totals: StravaSportTotals;
  recent_swim_totals: StravaSportTotals;
  ytd_run_totals: StravaSportTotals;
  ytd_ride_totals: StravaSportTotals;
  ytd_swim_totals: StravaSportTotals;
  all_run_totals: StravaSportTotals;
  all_ride_totals: StravaSportTotals;
  all_swim_totals: StravaSportTotals;
}
