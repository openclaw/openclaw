import { useState, useEffect, useCallback } from "react";
import { getMe } from "./api";
import Layout from "./components/Layout";
import Events from "./pages/Events";
import InstanceDetail from "./pages/InstanceDetail";
import Instances from "./pages/Instances";
import Login from "./pages/Login";

function useHash() {
  const [hash, setHash] = useState(window.location.hash || "#/login");
  useEffect(() => {
    const handler = () => setHash(window.location.hash || "#/login");
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHash();
  const [authed, setAuthed] = useState<boolean | null>(null);

  const checkAuth = useCallback(async () => {
    try {
      const { authenticated } = await getMe();
      setAuthed(authenticated);
      if (!authenticated && !window.location.hash.startsWith("#/login")) {
        window.location.hash = "#/login";
      }
    } catch {
      setAuthed(false);
      window.location.hash = "#/login";
    }
  }, []);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  if (authed === null) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-950 text-gray-400">
        Loading...
      </div>
    );
  }

  if (hash === "#/login" || !authed) {
    return (
      <Login
        onLogin={() => {
          setAuthed(true);
          window.location.hash = "#/instances";
        }}
      />
    );
  }

  let page: React.ReactNode;
  if (hash === "#/instances") {
    page = <Instances />;
  } else if (hash.startsWith("#/instances/")) {
    const id = hash.replace("#/instances/", "");
    page = <InstanceDetail id={id} />;
  } else if (hash === "#/events") {
    page = <Events />;
  } else {
    page = <Instances />;
  }

  return (
    <Layout
      onLogout={() => {
        setAuthed(false);
        window.location.hash = "#/login";
      }}
    >
      {page}
    </Layout>
  );
}
