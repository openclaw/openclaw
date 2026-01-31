export async function authenticate(url: string, code: string): Promise<string> {
  const resp = await fetch(`${url}/~/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `password=${code}`,
  });

  if (!resp.ok) {
    throw new Error(`Login failed with status ${resp.status}`);
  }

  await resp.text();
  const cookie = resp.headers.get("set-cookie");
  if (!cookie) {
    throw new Error("No authentication cookie received");
  }
  return cookie;
}
