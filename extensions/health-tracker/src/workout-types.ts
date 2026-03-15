export type Exercise = {
  id: string;
  canonicalName: string;
  muscleGroup?: string;
  slot?: string;
};

export type Program = {
  id: string;
  name: string;
  code?: string;
  days: ProgramDay[];
};

export type ProgramDay = {
  id: string;
  dayLabel: string;
  rotationOrder: number;
  focus?: string;
  exercises: ProgramDayExercise[];
};

export type ProgramDayExercise = {
  exerciseId: string;
  position: number;
  sets: number;
  repRanges: string[];
  style?: string;
  variations?: string[];
};

export type WorkoutSession = {
  id: string;
  date: string;
  programId?: string;
  programDayId?: string;
  source: string;
  status: "in_progress" | "completed";
  startedAt?: string;
  endedAt?: string;
  sets: LoggedSet[];
};

export type LoggedSet = {
  id: string;
  exerciseId: string;
  setNumber: number;
  weight: number;
  reps: number;
  note?: string;
};

export type SetTarget = {
  setNumber: number;
  weight: number;
  repMin: number;
  repMax: number;
  repGoal: string;
};

export type PlateauInfo = {
  stuckFor: number;
  lastWeight: number;
  suggestion: string;
};

export type ExercisePlan = {
  id: string;
  baseExerciseId: string;
  name: string;
  slot?: string;
  sets: number;
  repRanges: string[];
  style?: string;
  lastSets: { date: string; weight: number; reps: number; setNumber: number }[];
  suggestion: string;
  suggestedWeight: number;
  setTargets: SetTarget[];
  restSeconds: number;
  swapVariants: { id: string; name: string }[];
  plateau: PlateauInfo | null;
};

export type WorkoutPlan = {
  lastSessionDate: string | null;
  nextDay: (ProgramDay & { programName?: string }) | null;
  exercises: ExercisePlan[];
  allDays: { id: string; rotationOrder: number; focus?: string; dayLabel: string }[];
};

export type GarminDailyMetrics = {
  date: string;
  rhr?: number;
  hrv?: number;
  steps?: number;
  caloriesActive?: number;
  caloriesResting?: number;
  weight?: number;
  sleepScore?: number;
  sleepDurationSeconds?: number;
  sleepDeepSeconds?: number;
  sleepLightSeconds?: number;
  sleepRemSeconds?: number;
  sleepAwakeSeconds?: number;
  bodyBatteryStart?: number;
  bodyBatteryEnd?: number;
  stressAvg?: number;
};

export type HrvDayAnalysis = {
  date: string;
  hrvRaw?: number;
  rhrRaw?: number;
  hrv7dMa?: number;
  hrvBaseline60d?: number;
  hrvSd60d?: number;
  hrvNormalLow?: number;
  hrvNormalHigh?: number;
  hrvStatus?: string;
  hrvPctFromBaseline?: number;
  rhrBaseline60d?: number;
  rhrSd60d?: number;
  rhrNormalLow?: number;
  rhrNormalHigh?: number;
  rhrStatus?: string;
  hrvCv7d?: number;
  trend28d?: string;
  hrvTrendDirection?: string;
  rhrTrendDirection?: string;
  cvTrendDirection?: string;
  daysBelowHrvNormal?: number;
  postWorkout?: boolean;
};
