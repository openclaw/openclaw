import { parseMotionSpecFromFile } from "../src/engine/parser/parseMotionSpecNode";
import { generateVariants } from "../src/engine/variants/generateVariants";

const base = parseMotionSpecFromFile("../../data/datasets/cutmv/motion/specs/cutmv_premium_v001.json");
generateVariants(base);
console.log("Variants created in ../../data/datasets/cutmv/motion/specs/variants/");
