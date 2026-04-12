// Entur Geocoder API response types

export type GeocoderFeature = {
  geometry: {
    coordinates: [longitude: number, latitude: number];
  };
  properties: {
    id: string;
    name: string;
    locality?: string;
    county?: string;
    category?: string[];
  };
};

export type GeocoderResponse = {
  features: GeocoderFeature[];
};

// Entur Journey Planner GraphQL response types

export type EstimatedCall = {
  expectedDepartureTime: string;
  aimedDepartureTime: string;
  realtime: boolean;
  cancellation: boolean;
  destinationDisplay: {
    frontText: string;
  };
  serviceJourney: {
    line: {
      id: string;
      publicCode: string;
      transportMode: string;
    };
  };
  quay: {
    id: string;
    name: string;
    publicCode: string | null;
  };
};

export type StopPlaceResponse = {
  data: {
    stopPlace: {
      id: string;
      name: string;
      estimatedCalls: EstimatedCall[];
    } | null;
  };
  errors?: Array<{ message: string }>;
};

// Normalized output types

export type StopResult = {
  id: string;
  name: string;
  locality: string | null;
  county: string | null;
  latitude: number;
  longitude: number;
  transportModes: string[];
};

export type DepartureResult = {
  line: string;
  destination: string;
  transportMode: string;
  scheduledTime: string;
  expectedTime: string;
  minutesUntil: number;
  realtime: boolean;
  cancelled: boolean;
  platform: string | null;
};
