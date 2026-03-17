import { escapeOData, fetchGraphJson } from "./graph.js";
async function searchGraphUsers(params) {
  const query = params.query.trim();
  if (!query) {
    return [];
  }
  if (query.includes("@")) {
    const escaped = escapeOData(query);
    const filter = `(mail eq '${escaped}' or userPrincipalName eq '${escaped}')`;
    const path2 = `/users?$filter=${encodeURIComponent(filter)}&$select=id,displayName,mail,userPrincipalName`;
    const res2 = await fetchGraphJson({ token: params.token, path: path2 });
    return res2.value ?? [];
  }
  const top = typeof params.top === "number" && params.top > 0 ? params.top : 10;
  const path = `/users?$search=${encodeURIComponent(`"displayName:${query}"`)}&$select=id,displayName,mail,userPrincipalName&$top=${top}`;
  const res = await fetchGraphJson({
    token: params.token,
    path,
    headers: { ConsistencyLevel: "eventual" }
  });
  return res.value ?? [];
}
export {
  searchGraphUsers
};
