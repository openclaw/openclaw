import React from "react";
import { CutmvAdEngine } from "../engine/CutmvAdEngine";
import { MotionSpec } from "../engine/parser/MotionSpecTypes";

export const CutmvPremiumAdEngine: React.FC<{ spec: MotionSpec }> = ({
  spec,
}) => {
  return <CutmvAdEngine spec={spec} />;
};
