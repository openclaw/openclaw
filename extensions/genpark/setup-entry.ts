export function setup() {
  console.log("Setting up GenPark plugin...");
  return async () => {
    console.log("Teardown GenPark plugin...");
  };
}
