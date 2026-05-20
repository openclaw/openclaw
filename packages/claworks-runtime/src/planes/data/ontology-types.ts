export interface FieldDefinition {
  name: string;
  type: "string" | "number" | "boolean" | "date" | "enum" | "ref";
  required?: boolean;
  enumValues?: string[];
  refType?: string;
  default?: unknown;
}

export interface ActionTypeDefinition {
  name: string;
  description?: string;
  params: FieldDefinition[];
  fsmTransition?: { from: string | string[]; to: string };
}

export interface FsmDefinition {
  field: string;
  initial: string;
  states: string[];
  transitions: Array<{ from: string | string[]; event: string; to: string }>;
}

export interface ObjectTypeDefinition {
  name: string;
  description?: string;
  pack: string;
  primaryKey: string;
  fields: FieldDefinition[];
  actions: ActionTypeDefinition[];
  fsm?: FsmDefinition;
}

export interface ValidationResult {
  valid: boolean;
  errors: Array<{ field: string; message: string }>;
}
