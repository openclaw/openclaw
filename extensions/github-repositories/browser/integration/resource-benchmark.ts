import { installProjectionFixture } from "../../../../ui/src/test-helpers/control-ui-projection-fixture.tsx";
import { createInstanceConsumers } from "./ci-resource-fixture.ts";

// The benchmark owns vendor components; the native fixture supplies actual Gateway resources.
installProjectionFixture(createInstanceConsumers);
