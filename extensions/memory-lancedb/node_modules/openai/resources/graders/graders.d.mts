import { APIResource } from "../../core/resource.mjs";
import * as GraderModelsAPI from "./grader-models.mjs";
import { GraderInputs, GraderModels, LabelModelGrader, MultiGrader, PythonGrader, ScoreModelGrader, StringCheckGrader, TextSimilarityGrader } from "./grader-models.mjs";
export declare class Graders extends APIResource {
    graderModels: GraderModelsAPI.GraderModels;
}
export declare namespace Graders {
    export { GraderModels as GraderModels, type GraderInputs as GraderInputs, type LabelModelGrader as LabelModelGrader, type MultiGrader as MultiGrader, type PythonGrader as PythonGrader, type ScoreModelGrader as ScoreModelGrader, type StringCheckGrader as StringCheckGrader, type TextSimilarityGrader as TextSimilarityGrader, };
}
//# sourceMappingURL=graders.d.mts.map