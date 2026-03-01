import { SetupProvider } from "./context";
import { Outlet } from "react-router";

export default function Setup() {
  return (
    <SetupProvider>
      <Outlet />
    </SetupProvider>
  );
}
