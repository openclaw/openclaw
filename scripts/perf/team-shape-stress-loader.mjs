// Load TypeScript instrumentation without redirecting built Gateway package imports
// through the controller checkout's tsconfig aliases. This must be the first loader.
import { register } from "tsx/esm/api";

register({ tsconfig: false });
